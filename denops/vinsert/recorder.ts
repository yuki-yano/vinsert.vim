import type { RuntimeConfig } from "./config.ts";

export type RecorderHandle = {
  process: Deno.ChildProcess;
  filepath: string;
  stderrPromise?: Promise<Uint8Array[]>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function startRecording(config: RuntimeConfig): Promise<RecorderHandle> {
  const filepath = await Deno.makeTempFile({ suffix: ".wav" });
  const baseArgs = config.ffmpegArgs.length > 0
    ? config.ffmpegArgs
    : defaultInputArgs();
  const args = [
    ...baseArgs,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-y",
    filepath,
  ];
  const command = new Deno.Command(config.ffmpegPath, {
    args,
    stdin: "piped",
    stdout: "null",
    stderr: "piped",
  });
  const process = command.spawn();
  const stderrPromise = process.stderr ? drainStream(process.stderr) : undefined;
  console.log(`[vinsert] ffmpeg start: ${config.ffmpegPath} ${args.join(" ")}`);
  return { process, filepath, stderrPromise };
}

export async function stopRecording(
  handle: RecorderHandle | null,
  keepAudio: boolean,
): Promise<Uint8Array> {
  if (!handle) {
    throw new Error("Recorder is not active");
  }
  const { process, filepath, stderrPromise } = handle;
  await sendQuitSignal(process).catch((error) => {
    console.warn("[vinsert] stopRecording: failed to signal ffmpeg", error);
  });
  const status = await process.status;
  const stderrText = await readStderr(stderrPromise);
  console.log(`[vinsert] stopRecording: ffmpeg exited with code ${status.code}`);
  if (!status.success) {
    throw new Error(`ffmpeg exited with code ${status.code}: ${stderrText}`);
  }
  const wav = await Deno.readFile(filepath);
  if (!keepAudio) {
    try {
      await Deno.remove(filepath);
    } catch {
      // ignore cleanup error
    }
  }
  return wav;
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function defaultInputArgs(): string[] {
  switch (Deno.build.os) {
    case "darwin":
      return ["-f", "avfoundation", "-i", ":0"];
    case "windows":
      return ["-f", "dshow", "-i", "audio=default"];
    default:
      return ["-f", "pulse", "-i", "default"];
  }
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } catch (error) {
    console.warn("[vinsert] ffmpeg stderr read error", error);
  } finally {
    reader.releaseLock();
  }
  return chunks;
}

async function readStderr(reader?: Promise<Uint8Array[]>): Promise<string> {
  if (!reader) return "";
  try {
    const chunks = await reader;
    if (chunks.length === 0) return "";
    return decoder.decode(concatenate(chunks));
  } catch (error) {
    console.warn("[vinsert] stderr decode error", error);
    return "";
  }
}

async function sendQuitSignal(process: Deno.ChildProcess): Promise<void> {
  const stdin = process.stdin;
  if (!stdin) {
    return;
  }
  try {
    console.log("[vinsert] stopRecording: sending 'q' to ffmpeg");
    const writer = stdin.getWriter();
    await writer.write(encoder.encode("q\n"));
    await writer.close();
  } catch (error) {
    console.warn("[vinsert] stopRecording: write via writer failed", error);
    try {
      await stdin.close();
    } catch {
      // ignore
    }
    throw error;
  }
}
