package com.mori.downloader;
import android.content.Context;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream;

/** Downloads the official Spleeter 2-stem FP16 model once and keeps it locally for offline use. */
public final class SpleeterModelManager {
    private static final String MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2";
    private SpleeterModelManager() {}

    public static File[] ensureModels(Context context) throws Exception {
        File folder = new File(context.getFilesDir(), "spleeter-2stems-fp16");
        File vocals = new File(folder, "vocals.fp16.onnx");
        File accompaniment = new File(folder, "accompaniment.fp16.onnx");
        if (vocals.isFile() && vocals.length() > 5_000_000L && accompaniment.isFile() && accompaniment.length() > 5_000_000L)
            return new File[]{vocals, accompaniment};
        if (!folder.exists() && !folder.mkdirs()) throw new IllegalStateException("Cannot create Spleeter model folder.");
        File archive = new File(context.getCacheDir(), "spleeter-models.tar.bz2");
        download(MODEL_URL, archive);
        File vocalsPart = new File(folder, "vocals.fp16.onnx.part");
        File accompanimentPart = new File(folder, "accompaniment.fp16.onnx.part");
        boolean foundVocals = false, foundAccompaniment = false;
        try (InputStream fileIn = new BufferedInputStream(new FileInputStream(archive));
             BZip2CompressorInputStream bzIn = new BZip2CompressorInputStream(fileIn);
             TarArchiveInputStream tar = new TarArchiveInputStream(bzIn)) {
            TarArchiveEntry entry;
            byte[] buffer = new byte[64 * 1024];
            while ((entry = tar.getNextTarEntry()) != null) {
                if (!entry.isFile()) continue;
                String name = entry.getName();
                File destination = null;
                if (name.endsWith("/vocals.fp16.onnx") || name.equals("vocals.fp16.onnx")) destination = vocalsPart;
                else if (name.endsWith("/accompaniment.fp16.onnx") || name.equals("accompaniment.fp16.onnx")) destination = accompanimentPart;
                if (destination == null) continue;
                try (FileOutputStream out = new FileOutputStream(destination)) {
                    int count;
                    while ((count = tar.read(buffer)) != -1) out.write(buffer, 0, count);
                }
                if (destination == vocalsPart) foundVocals = true;
                if (destination == accompanimentPart) foundAccompaniment = true;
                if (foundVocals && foundAccompaniment) break;
            }
        } finally { archive.delete(); }
        if (!foundVocals || !foundAccompaniment || vocalsPart.length() < 5_000_000L || accompanimentPart.length() < 5_000_000L) {
            vocalsPart.delete(); accompanimentPart.delete();
            throw new IllegalStateException("The downloaded Spleeter model archive is incomplete.");
        }
        if (vocals.exists()) vocals.delete();
        if (accompaniment.exists()) accompaniment.delete();
        if (!vocalsPart.renameTo(vocals) || !accompanimentPart.renameTo(accompaniment)) {
            vocalsPart.delete(); accompanimentPart.delete();
            throw new IllegalStateException("Could not install the Spleeter model files.");
        }
        return new File[]{vocals, accompaniment};
    }

    private static void download(String address, File destination) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(30000);
        connection.setReadTimeout(120000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("User-Agent", "Mori-Android");
        try {
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IllegalStateException("Spleeter model download failed (HTTP " + status + ").");
            try (InputStream in = new BufferedInputStream(connection.getInputStream());
                 BufferedOutputStream out = new BufferedOutputStream(new FileOutputStream(destination))) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
                out.flush();
            }
            if (destination.length() < 10_000_000L) throw new IllegalStateException("The Spleeter model download is incomplete.");
        } finally { connection.disconnect(); }
    }
}
