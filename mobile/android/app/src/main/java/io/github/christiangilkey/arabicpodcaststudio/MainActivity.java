package io.github.christiangilkey.arabicpodcaststudio;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Our own native plugin (Google sign-in for Drive sync) must be registered before startup.
        registerPlugin(GoogleDriveAuthPlugin.class);
        super.onCreate(savedInstanceState);
        // Lets the video player stream the user's own videos straight from Google Drive.
        getBridge().setWebViewClient(new DriveMediaWebViewClient(getBridge()));
    }
}
