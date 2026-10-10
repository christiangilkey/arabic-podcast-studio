package io.github.christiangilkey.arabicpodcaststudio;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;

import java.net.URLEncoder;

/**
 * The app's own small web browser: an address bar with back / forward / close on top, the page
 * below, and an "Import Page" button floating at the bottom right.
 *
 * Pressing Import Page runs the app's text extractor (web/js/extract.js, passed in as source)
 * inside the page being viewed and hands the result to the listener. The page itself is given
 * no access to the app: this WebView has no bridge to the app's code.
 */
final class InAppBrowser {
    interface Listener {
        /** `json` is the page's answer exactly as WebView returns it (a JSON-encoded string). */
        void onImport(String json);
    }

    private static final String HOME = "https://www.google.com/";

    private InAppBrowser() {}

    /** A typed address, or a web search for typed words, or the home page for nothing. */
    static String startUrl(String text) {
        String t = text == null ? "" : text.trim();
        if (t.isEmpty()) return HOME;
        if (t.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) return t;
        if (!t.contains(" ") && t.contains(".")) return "https://" + t;
        try {
            return "https://www.google.com/search?q=" + URLEncoder.encode(t, "UTF-8");
        } catch (Exception e) {
            return HOME;
        }
    }

    static void open(Activity activity, String url, String extractor, Listener listener) {
        float dp = activity.getResources().getDisplayMetrics().density;
        int pad = Math.round(6 * dp);
        int dark = Color.parseColor("#1c1c1a");
        int ink = Color.parseColor("#f2f1ec");
        int accent = Color.parseColor("#2dd4bf");

        Dialog dialog = new Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar);
        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(dark);
        root.setFitsSystemWindows(true);

        // ----- top bar -----
        LinearLayout bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(pad, pad, pad, pad);
        Button back = barButton(activity, "‹", ink, dp);
        Button forward = barButton(activity, "›", ink, dp);
        Button close = barButton(activity, "✕", ink, dp);
        EditText address = new EditText(activity);
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setHint("Search or type a web address");
        address.setTextColor(ink);
        address.setHintTextColor(Color.parseColor("#8a8880"));
        address.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        address.setSelectAllOnFocus(true);
        GradientDrawable field = new GradientDrawable();
        field.setColor(Color.parseColor("#141413"));
        field.setCornerRadius(8 * dp);
        address.setBackground(field);
        address.setPadding(Math.round(10 * dp), Math.round(8 * dp), Math.round(10 * dp), Math.round(8 * dp));
        bar.addView(back);
        bar.addView(forward);
        LinearLayout.LayoutParams grow = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        grow.setMargins(pad, 0, pad, 0);
        bar.addView(address, grow);
        bar.addView(close);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        ProgressBar progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.round(3 * dp)));

        // ----- page + floating Import Page button -----
        FrameLayout frame = new FrameLayout(activity);
        WebView web = new WebView(activity);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setBuiltInZoomControls(true);
        web.getSettings().setDisplayZoomControls(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void doUpdateVisitedHistory(WebView view, String current, boolean isReload) {
                if (!address.hasFocus()) address.setText(current);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int value) {
                progress.setProgress(value);
                progress.setVisibility(value >= 100 ? View.INVISIBLE : View.VISIBLE);
            }
        });
        frame.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        Button importButton = new Button(activity);
        importButton.setText("Import Page");
        importButton.setAllCaps(false);
        importButton.setTextColor(Color.parseColor("#062a26"));
        importButton.setTypeface(Typeface.DEFAULT_BOLD);
        importButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        GradientDrawable pill = new GradientDrawable();
        pill.setColor(accent);
        pill.setCornerRadius(24 * dp);
        importButton.setBackground(pill);
        importButton.setPadding(Math.round(18 * dp), Math.round(10 * dp), Math.round(18 * dp), Math.round(10 * dp));
        importButton.setElevation(6 * dp);
        FrameLayout.LayoutParams corner = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.END);
        corner.setMargins(0, 0, Math.round(16 * dp), Math.round(20 * dp));
        frame.addView(importButton, corner);
        root.addView(frame, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // ----- behaviour -----
        back.setOnClickListener(v -> { if (web.canGoBack()) web.goBack(); });
        forward.setOnClickListener(v -> { if (web.canGoForward()) web.goForward(); });
        close.setOnClickListener(v -> dialog.dismiss());
        address.setOnEditorActionListener((v, actionId, event) -> {
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                && event.getAction() == KeyEvent.ACTION_DOWN;
            if (actionId != EditorInfo.IME_ACTION_GO && !enter) return false;
            web.loadUrl(startUrl(address.getText().toString()));
            address.clearFocus();
            InputMethodManager keyboard = (InputMethodManager) activity.getSystemService(Activity.INPUT_METHOD_SERVICE);
            if (keyboard != null) keyboard.hideSoftInputFromWindow(address.getWindowToken(), 0);
            return true;
        });
        importButton.setOnClickListener(v -> {
            String script = "(function(){" + extractor
                + "\nreturn JSON.stringify(extractArticle(document, location.href));})()";
            web.evaluateJavascript(script, listener::onImport);
        });
        dialog.setOnKeyListener((d, keyCode, event) -> {
            if (keyCode == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP && web.canGoBack()) {
                web.goBack();
                return true;
            }
            return false;
        });
        dialog.setOnDismissListener(d -> {
            web.stopLoading();
            frame.removeView(web);
            web.destroy();
        });

        dialog.setContentView(root);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        }
        dialog.show();
        web.loadUrl(startUrl(url));
    }

    private static Button barButton(Activity activity, String label, int color, float dp) {
        Button b = new Button(activity);
        b.setText(label);
        b.setTextColor(color);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        b.setBackgroundColor(Color.TRANSPARENT);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setPadding(Math.round(12 * dp), 0, Math.round(12 * dp), 0);
        b.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Math.round(40 * dp)));
        return b;
    }
}
