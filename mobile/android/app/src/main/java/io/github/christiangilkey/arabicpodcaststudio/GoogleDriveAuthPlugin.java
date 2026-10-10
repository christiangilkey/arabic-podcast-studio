package io.github.christiangilkey.arabicpodcaststudio;

import android.app.Activity;
import android.os.CancellationSignal;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;

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
import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

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

    /**
     * A Google ID token (signed proof of which account is using the app) for the online features.
     * The Drive sign-in above only grants access, so this uses Credential Manager. The token is
     * issued for the app's "Web" client (serverClientId), which Supabase is set up to trust.
     */
    @PluginMethod
    public void getIdToken(PluginCall call) {
        String serverClientId = call.getString("serverClientId");
        if (serverClientId == null) {
            call.reject("Missing serverClientId.");
            return;
        }
        GetGoogleIdOption.Builder option = new GetGoogleIdOption.Builder()
            .setServerClientId(serverClientId)
            .setFilterByAuthorizedAccounts(false)
            .setAutoSelectEnabled(true);
        String nonce = call.getString("nonce");
        if (nonce != null) option.setNonce(nonce);
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(option.build())
            .build();
        CredentialManager.create(getContext()).getCredentialAsync(
            getActivity(), request, new CancellationSignal(), ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    Credential credential = response.getCredential();
                    if (!(credential instanceof CustomCredential)
                        || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                        call.reject("Google returned an unexpected kind of sign-in.");
                        return;
                    }
                    try {
                        GoogleIdTokenCredential google =
                            GoogleIdTokenCredential.createFrom(((CustomCredential) credential).getData());
                        JSObject out = new JSObject();
                        out.put("idToken", google.getIdToken());
                        out.put("email", google.getId());
                        call.resolve(out);
                    } catch (Exception e) {
                        call.reject("Couldn't read Google's answer: " + e.getMessage(), e);
                    }
                }

                @Override
                public void onError(GetCredentialException e) {
                    call.reject("Google sign-in failed: " + e.getMessage(), e);
                }
            });
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
