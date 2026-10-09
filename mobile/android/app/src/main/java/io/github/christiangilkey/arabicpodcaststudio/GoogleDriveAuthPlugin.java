package io.github.christiangilkey.arabicpodcaststudio;

import android.app.Activity;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;

import java.util.Arrays;

/**
 * Google sign-in for Drive sync, using Google's Authorization API (Google Play services).
 *
 * The app asks only for its own hidden Drive folder plus the account's email. Google
 * recognises the app by its package name and signing-key fingerprint, so no client secret
 * is needed on the phone. After the first consent, later calls return a fresh access token
 * silently.
 */
@CapacitorPlugin(name = "GoogleDriveAuth")
public class GoogleDriveAuthPlugin extends Plugin {
    private ActivityResultLauncher<IntentSenderRequest> launcher;
    private PluginCall pending;

    @Override
    public void load() {
        launcher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(), this::onConsentResult);
    }

    private AuthorizationRequest request() {
        return AuthorizationRequest.builder()
            .setRequestedScopes(Arrays.asList(
                new Scope("https://www.googleapis.com/auth/drive.appdata"),
                new Scope("email"),
                new Scope("openid")))
            .build();
    }

    @PluginMethod
    public void authorize(PluginCall call) {
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", true));
        Identity.getAuthorizationClient(getActivity()).authorize(request())
            .addOnSuccessListener(result -> {
                if (!result.hasResolution()) {
                    resolveWith(call, result);
                } else if (!interactive) {
                    call.reject("NEEDS_INTERACTION");
                } else {
                    if (pending != null) pending.reject("Another sign-in started.");
                    pending = call;
                    launcher.launch(new IntentSenderRequest.Builder(
                        result.getPendingIntent().getIntentSender()).build());
                }
            })
            .addOnFailureListener(e -> call.reject("Google sign-in failed: " + e.getMessage(), e));
    }

    /** Hands the current access token to the video streamer (see DriveMediaWebViewClient). */
    @PluginMethod
    public void setMediaToken(PluginCall call) {
        DriveMediaWebViewClient.setToken(call.getString("token"));
        call.resolve();
    }

    private void onConsentResult(ActivityResult r) {
        PluginCall call = pending;
        pending = null;
        if (call == null) return;
        if (r.getResultCode() != Activity.RESULT_OK) {
            call.reject("Sign-in was cancelled.");
            return;
        }
        try {
            AuthorizationResult result =
                Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(r.getData());
            resolveWith(call, result);
        } catch (ApiException e) {
            call.reject("Google sign-in failed: " + e.getMessage(), e);
        }
    }

    private void resolveWith(PluginCall call, AuthorizationResult result) {
        if (result.getAccessToken() == null) {
            call.reject("Google didn't return an access token.");
            return;
        }
        JSObject out = new JSObject();
        out.put("accessToken", result.getAccessToken());
        out.put("scopes", new JSArray(result.getGrantedScopes()));
        call.resolve(out);
    }
}
