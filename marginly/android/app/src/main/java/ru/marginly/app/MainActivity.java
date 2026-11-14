package ru.marginly.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.Window;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.util.ArrayList;

/** Marginly: интерфейс лежит внутри приложения, данные синхронизируются с сервером Marginly. */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final int PICK_PHOTO = 1;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#15171A"));
        w.setNavigationBarColor(Color.parseColor("#15171A"));

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#F1F2EF"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                openPicker(params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                return true;
            }
        });
        setContentView(web);
        if (state != null) web.restoreState(state);
        else web.loadUrl("https://" + HOST + "/assets/index.html");
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.__onBack ? window.__onBack() : false", v -> {
            if ("true".equals(v)) return;
            if (web.canGoBack()) web.goBack();
            else finish();
        });
    }

    /* ── фото: галерея или камера ── */
    private void openPicker(boolean multiple) {
        Intent gallery = new Intent(Intent.ACTION_GET_CONTENT);
        gallery.addCategory(Intent.CATEGORY_OPENABLE);
        gallery.setType("image/*");
        if (multiple) gallery.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

        ArrayList<Intent> extra = new ArrayList<>();
        try {
            File dir = new File(getCacheDir(), "camera");
            dir.mkdirs();
            File shot = new File(dir, "shot-" + System.currentTimeMillis() + ".jpg");
            cameraUri = FileProvider.getUriForFile(this, getPackageName() + ".files", shot);
            Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            camera.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
            camera.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (camera.resolveActivity(getPackageManager()) != null) extra.add(camera);
        } catch (Exception e) {
            cameraUri = null;
        }
        Intent chooser = Intent.createChooser(gallery, "Фото товара");
        if (!extra.isEmpty()) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, extra.toArray(new Intent[0]));
        try {
            startActivityForResult(chooser, PICK_PHOTO);
        } catch (Exception e) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_PHOTO || fileCallback == null) return;
        Uri[] uris = null;
        if (result == RESULT_OK) {
            if (data != null && data.getClipData() != null) {
                ClipData clip = data.getClipData();
                uris = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) uris[i] = clip.getItemAt(i).getUri();
            } else if (data != null && data.getData() != null) {
                uris = new Uri[]{data.getData()};
            } else if (cameraUri != null) {
                uris = new Uri[]{cameraUri};
            }
        }
        fileCallback.onReceiveValue(uris);
        fileCallback = null;
    }
}
