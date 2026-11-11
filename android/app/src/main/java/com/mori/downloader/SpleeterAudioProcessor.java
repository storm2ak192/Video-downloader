package com.mori.downloader;
import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.util.UnstableApi;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Chunked Spleeter vocals processor used by Media3 Transformer. */
@UnstableApi
public final class SpleeterAudioProcessor implements AudioProcessor, AutoCloseable {
    private static final int CHUNK_SECONDS = 8;
    private final String vocalsPath, accompanimentPath;
    private AudioFormat inputFormat = AudioFormat.NOT_SET, outputFormat = AudioFormat.NOT_SET;
    private float[] pending;
    private int pendingFrames, chunkFrames;
    private long engineHandle;
    private ByteBuffer outputBuffer = EMPTY_BUFFER;
    private boolean inputEnded;

    public SpleeterAudioProcessor(String vocalsPath, String accompanimentPath) {
        this.vocalsPath = vocalsPath;
        this.accompanimentPath = accompanimentPath;
    }

    @Override public AudioFormat configure(AudioFormat format) throws UnhandledAudioFormatException {
        if (format.encoding != C.ENCODING_PCM_FLOAT && format.encoding != C.ENCODING_PCM_16BIT)
            throw new UnhandledAudioFormatException("Spleeter requires PCM float or PCM 16-bit audio", format);
        if (format.sampleRate <= 0 || format.channelCount < 1 || format.channelCount > 2)
            throw new UnhandledAudioFormatException("Spleeter supports mono or stereo PCM audio", format);
        inputFormat = format;
        outputFormat = new AudioFormat(format.sampleRate, format.channelCount, C.ENCODING_PCM_FLOAT);
        chunkFrames = Math.max(1, format.sampleRate * CHUNK_SECONDS);
        pending = new float[chunkFrames * format.channelCount];
        pendingFrames = 0;
        return outputFormat;
    }

    @Override public boolean isActive() { return outputFormat != AudioFormat.NOT_SET; }

    @Override public void queueInput(ByteBuffer inputBuffer) {
        if (outputBuffer.hasRemaining()) return;
        int channels = inputFormat.channelCount;
        int bytesPerSample = inputFormat.encoding == C.ENCODING_PCM_FLOAT ? 4 : 2;
        while (inputBuffer.remaining() >= bytesPerSample * channels && pendingFrames < chunkFrames) {
            int base = pendingFrames * channels;
            for (int c = 0; c < channels; c++) {
                float sample = inputFormat.encoding == C.ENCODING_PCM_FLOAT
                    ? inputBuffer.getFloat() : inputBuffer.getShort() / 32768.0f;
                pending[base + c] = Math.max(-1.0f, Math.min(1.0f, sample));
            }
            pendingFrames++;
        }
        if (pendingFrames == chunkFrames) processPending();
    }

    @Override public void queueEndOfStream() {
        inputEnded = true;
        if (!outputBuffer.hasRemaining() && pendingFrames > 0) processPending();
    }

    private void processPending() {
        if (pendingFrames <= 0) return;
        if (engineHandle == 0) {
            engineHandle = nativeCreate(vocalsPath, accompanimentPath, 1);
            if (engineHandle == 0) throw new IllegalStateException("Could not initialize the Spleeter engine.");
        }
        int sampleCount = pendingFrames * inputFormat.channelCount;
        float[] input = new float[sampleCount];
        System.arraycopy(pending, 0, input, 0, sampleCount);
        float[] separated = nativeSeparate(engineHandle, input, inputFormat.channelCount, pendingFrames, inputFormat.sampleRate);
        if (separated == null || separated.length != sampleCount)
            throw new IllegalStateException("Spleeter did not return a compatible vocals audio stream.");
        outputBuffer = ByteBuffer.allocateDirect(separated.length * 4).order(ByteOrder.nativeOrder());
        for (float value : separated) outputBuffer.putFloat(value);
        outputBuffer.flip();
        pendingFrames = 0;
    }

    @Override public ByteBuffer getOutput() {
        ByteBuffer result = outputBuffer;
        outputBuffer = EMPTY_BUFFER;
        return result;
    }
    @Override public boolean isEnded() { return inputEnded && pendingFrames == 0 && !outputBuffer.hasRemaining(); }
    @Override public void flush() {
        pendingFrames = 0;
        outputBuffer = EMPTY_BUFFER;
        inputEnded = false;
        if (pending != null) java.util.Arrays.fill(pending, 0f);
    }
    @Override public void reset() {
        flush();
        inputFormat = AudioFormat.NOT_SET;
        outputFormat = AudioFormat.NOT_SET;
        pending = null;
        chunkFrames = 0;
        close();
    }
    @Override public void close() {
        if (engineHandle != 0) { nativeDestroy(engineHandle); engineHandle = 0; }
    }
    private static native long nativeCreate(String vocalsPath, String accompanimentPath, int threads);
    private static native float[] nativeSeparate(long handle, float[] interleaved, int channels, int frames, int sampleRate);
    private static native void nativeDestroy(long handle);
    static { System.loadLibrary("morispleeter"); }
}
