package io.github.christiangilkey.arabicpodcaststudio;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Streams the user's own videos from their Google Drive into the app's video player.
 *
 * Drive only accepts the sign-in token as an "Authorization" header, which a <video> element
 * can't send. So the player asks for https://localhost/_drive/<file id> and this class fetches
 * that file from Drive with the header added, passing "Range" through so seeking only
 * downloads the part that's needed. Everything else goes to Capacitor as usual.
 */
public class DriveMediaWebViewClient extends BridgeWebViewClient {
    private static final String PREFIX = "/_drive/";
    private static volatile String token;

    public DriveMediaWebViewClient(Bridge bridge) {
        super(bridge);
    }

    /** Called from JavaScript (GoogleDriveAuth.setMediaToken) whenever the access token changes. */
    static void setToken(String value) {
        token = value;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        String path = url.getPath();
        if ("localhost".equals(url.getHost()) && path != null && path.startsWith(PREFIX)) {
            return proxy(path.substring(PREFIX.length()), request.getRequestHeaders());
        }
        return super.shouldInterceptRequest(view, request);
    }

    private static String header(Map<String, String> headers, String name) {
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (e.getKey() != null && e.getKey().equalsIgnoreCase(name)) return e.getValue();
        }
        return null;
    }

    private WebResourceResponse proxy(String fileId, Map<String, String> requestHeaders) {
        try {
            URL drive = new URL("https://www.googleapis.com/drive/v3/files/"
                + URLEncoder.encode(fileId, "UTF-8") + "?alt=media");
            HttpURLConnection conn = (HttpURLConnection) drive.openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            String range = header(requestHeaders, "Range");
            if (range != null) conn.setRequestProperty("Range", range);
            int code = conn.getResponseCode();

            Map<String, String> headers = new HashMap<>();
            for (String name : new String[] {"Content-Range", "Content-Length"}) {
                String value = conn.getHeaderField(name);
                if (value != null) headers.put(name, value);
            }
            headers.put("Accept-Ranges", "bytes");
            headers.put("Cache-Control", "no-store");
            InputStream body = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (body == null) body = new ByteArrayInputStream(new byte[0]);
            String type = conn.getContentType();
            if (type == null || code >= 400) type = code >= 400 ? "text/plain" : "video/mp4";
            String reason = code == 206 ? "Partial Content" : code == 200 ? "OK" : "Drive error";
            return new WebResourceResponse(type, null, code, reason, headers, body);
        } catch (Exception e) {
            byte[] msg = ("Couldn't reach Google Drive: " + e.getMessage()).getBytes(StandardCharsets.UTF_8);
            return new WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", new HashMap<>(),
                new ByteArrayInputStream(msg));
        }
    }
}
