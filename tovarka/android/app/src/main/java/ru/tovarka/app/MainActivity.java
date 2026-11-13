package ru.tovarka.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Товарка: интерфейс лежит внутри приложения, данные и фото — в памяти телефона. */
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

        File photos = new File(getFilesDir(), "photos");
        photos.mkdirs();
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/_blob/", new WebViewAssetLoader.InternalStoragePathHandler(this, photos))
                .build();

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#F1F2EF"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.addJavascriptInterface(new Bridge(), "Android");
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

    /* ── мост для страницы ── */
    private class Bridge {
        private final File dataFile = new File(getFilesDir(), "data.json");
        private final File photosDir = new File(getFilesDir(), "photos");

        @JavascriptInterface
        public String loadAll() {
            try {
                if (!dataFile.exists()) return "{}";
                return new String(readAll(new FileInputStream(dataFile)), StandardCharsets.UTF_8);
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public synchronized boolean saveAll(String json) {
            try {
                File tmp = new File(getFilesDir(), "data.json.tmp");
                try (FileOutputStream out = new FileOutputStream(tmp)) {
                    out.write(json.getBytes(StandardCharsets.UTF_8));
                    out.getFD().sync();
                }
                if (dataFile.exists()) {
                    File bak = new File(getFilesDir(), "data.json.bak");
                    bak.delete();
                    dataFile.renameTo(bak);
                }
                return tmp.renameTo(dataFile);
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public String savePhoto(String base64) {
            try {
                photosDir.mkdirs();
                String name = UUID.randomUUID().toString() + ".jpg";
                try (FileOutputStream out = new FileOutputStream(new File(photosDir, name))) {
                    out.write(Base64.decode(base64, Base64.DEFAULT));
                }
                return name;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean deletePhoto(String name) {
            if (name == null || !name.matches("[0-9a-f-]{36}\\.jpg")) return false;
            return new File(photosDir, name).delete();
        }

        /** Курс юаня ЦБ: {"rate": 12.3149, "date": "2026-11-14"} или {} без интернета. */
        @JavascriptInterface
        public String fetchCbr() {
            try {
                JSONObject d = new JSONObject(new String(get("https://www.cbr-xml-daily.ru/daily_json.js"), StandardCharsets.UTF_8));
                JSONObject cny = d.getJSONObject("Valute").getJSONObject("CNY");
                double rate = cny.getDouble("Value") / cny.getDouble("Nominal");
                return result(rate, d.getString("Date").substring(0, 10));
            } catch (Exception ignored) { }
            try {
                String xml = new String(get("https://www.cbr.ru/scripts/XML_daily.asp"), "windows-1251");
                Matcher m = Pattern.compile("<CharCode>CNY</CharCode>\\s*<Nominal>(\\d+)</Nominal>.*?<Value>([\\d,]+)</Value>", Pattern.DOTALL).matcher(xml);
                Matcher dm = Pattern.compile("Date=\"(\\d{2})\\.(\\d{2})\\.(\\d{4})\"").matcher(xml);
                if (m.find()) {
                    double rate = Double.parseDouble(m.group(2).replace(',', '.')) / Double.parseDouble(m.group(1));
                    String date = dm.find() ? dm.group(3) + "-" + dm.group(2) + "-" + dm.group(1) : "";
                    return result(rate, date);
                }
            } catch (Exception ignored) { }
            return "{}";
        }

        private String result(double rate, String date) throws Exception {
            JSONObject r = new JSONObject();
            r.put("rate", Math.round(rate * 10000) / 10000.0);
            r.put("date", date);
            return r.toString();
        }

        private byte[] get(String url) throws Exception {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setRequestProperty("User-Agent", "Tovarka/1.0");
            try (InputStream in = c.getInputStream()) {
                return readAll(in);
            } finally {
                c.disconnect();
            }
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        try (InputStream src = in) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[16384];
            int n;
            while ((n = src.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toByteArray();
        }
    }
}
