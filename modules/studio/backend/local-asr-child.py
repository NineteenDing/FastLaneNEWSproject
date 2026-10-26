"""Fixed offline faster-whisper adapter. Caller owns the temporary input/output directory."""
import json
import os
import sys
import hashlib
import base64
from fractions import Fraction
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["OPENBLAS_NUM_THREADS"] = "2"

source, model_dir, output = (Path(value).resolve() for value in sys.argv[1:4])
frames_only = len(sys.argv) > 5 and sys.argv[5] == "frames"
maximum_output_bytes = (6 if frames_only else 8) * 1024 * 1024

def media_duration(audio_seconds=0):
    # An audio track may end before a silent video tail; keep the two coverages separate.
    durations = [audio_seconds]
    with av.open(str(source), mode="r", options={"protocol_whitelist": "file", "format_whitelist": "mov,matroska,webm,mp3,wav,ogg,aac,flac", "probesize": "8388608"}) as container:
        if container.duration is not None:
            durations.append(container.duration / av.time_base)
        for stream in container.streams:
            if stream.type in ["video", "audio"] and stream.duration is not None and stream.time_base:
                durations.append(float(stream.duration * stream.time_base))
    if not all(np.isfinite(value) for value in durations) or not 0 < max(durations) <= 7200:
        raise ValueError("media duration unavailable or too long")
    return max(durations)

def decoded_audio(required=False):
    """Original bounded mono decoder, shared by ASR and subtitle-only observations."""
    samples = 0
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
    with av.open(str(source), mode="r", options={"protocol_whitelist": "file", "format_whitelist": "mov,matroska,webm,mp3,wav,ogg,aac,flac", "probesize": "8388608"}) as container:
        if not container.streams.audio:
            if required:
                raise ValueError("audio unavailable")
            return
        if container.duration and container.duration / av.time_base > 7200:
            raise ValueError("audio duration limit")
        container.streams.audio[0].thread_count = 1
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                chunk = converted.to_ndarray().reshape(-1)
                samples += chunk.size
                if samples > 7200 * 16000 or not np.isfinite(chunk).all():
                    raise ValueError("audio duration or sample limit")
                yield chunk
        for converted in resampler.resample(None):
            chunk = converted.to_ndarray().reshape(-1)
            samples += chunk.size
            if samples > 7200 * 16000 or not np.isfinite(chunk).all():
                raise ValueError("audio duration or sample limit")
            yield chunk

class AudioRhythm:
    """Low-energy intervals are signal observations, never voice VAD or intentions."""
    def __init__(self):
        self.pending = np.empty(0, dtype=np.float32)
        self.samples = self.window_samples = self.quiet_samples = 0
        self.energy = 0.0
        self.quiet_start = None
        self.intervals, self.windows = [], []
        self.count, self.quiet_seconds = 0, 0.0

    def close_quiet(self, end):
        if self.quiet_start is not None and end - self.quiet_start >= 0.3 - 1e-6:
            self.count += 1
            self.quiet_seconds += end - self.quiet_start
            if len(self.intervals) < 120:
                self.intervals.append({"start": round(self.quiet_start, 4), "end": round(end, 4)})
        self.quiet_start = None

    def window(self):
        end = self.samples / 16000
        self.windows.append({"start": round(end - self.window_samples / 16000, 4), "end": round(end, 4),
                             "rmsDbfs": round(max(-120, 10 * np.log10(max(self.energy / self.window_samples, 1e-12))), 2),
                             "quietFraction": round(self.quiet_samples / self.window_samples, 4)})
        self.window_samples = self.quiet_samples = 0
        self.energy = 0.0

    def frame(self, values):
        start = self.samples / 16000
        energy = float(np.dot(values, values))
        quiet = energy / values.size <= 0.0001
        if quiet and self.quiet_start is None:
            self.quiet_start = start
        elif not quiet:
            self.close_quiet(start)
        self.samples += values.size
        self.window_samples += values.size
        self.energy += energy
        if quiet:
            self.quiet_samples += values.size
        if self.window_samples == 160000:
            self.window()

    def add(self, values):
        values = np.concatenate((self.pending, values))
        full = values.size // 320 * 320
        for offset in range(0, full, 320):
            self.frame(values[offset:offset + 320])
        self.pending = values[full:].copy()

    def finish(self):
        if self.pending.size:
            self.frame(self.pending)
        if not self.samples:
            return None
        self.close_quiet(self.samples / 16000)
        if self.window_samples:
            self.window()
        return {"method": "rms_20ms_v1", "timeBasis": "decoded_audio", "observedSeconds": round(self.samples / 16000, 4), "quietThresholdDbfs": -40,
                "minimumQuietSeconds": 0.3, "quietSeconds": round(self.quiet_seconds, 4), "quietIntervals": self.intervals,
                "quietIntervalCount": self.count, "truncated": self.count > len(self.intervals), "windows": self.windows}

def visual_rhythm(duration):
    """Bounded 2fps RGB differences, not a claim of exact cuts or complete motion understanding."""
    previous, origin, last_time = None, None, -1.0
    target, count, changes, until = 0.0, 0, 0, 0.0
    times, windows = [], {}
    with av.open(str(source), mode="r", options={"protocol_whitelist": "file", "format_whitelist": "mov,matroska,webm,mp3,wav,ogg,aac,flac", "probesize": "8388608"}) as container:
        if not container.streams.video:
            return None
        video = container.streams.video[0]
        if video.width * video.height > 32000000:
            raise ValueError("video dimensions limit")
        video.thread_count = 1
        for index, frame in enumerate(container.decode(video=0)):
            if index >= 1000000 or frame.time is None:
                raise ValueError("video rhythm decode budget or timestamp unavailable")
            origin = frame.time if origin is None else origin
            time = float(frame.time - origin)
            if time < last_time or time > duration + 0.1:
                raise ValueError("video rhythm timeline invalid")
            last_time = time
            if time + 1e-6 < target:
                continue
            pixels = frame.reformat(width=32, height=18, format="rgb24", threads=1).to_ndarray().astype(np.float32)
            changed = previous is not None and float(np.mean(np.abs(pixels - previous))) / 255 >= 0.18
            previous = pixels
            count += 1
            if count > 14401:
                raise ValueError("video rhythm sample budget")
            until = round(time, 4)
            bucket = int(time // 10)
            if bucket >= 720:
                raise ValueError("video rhythm timeline budget")
            window = windows.setdefault(bucket, {"start": bucket * 10, "end": min((bucket + 1) * 10, duration), "samples": 0, "changes": 0})
            window["samples"] += 1
            if changed:
                changes += 1
                window["changes"] += 1
                if len(times) < 120:
                    times.append(until)
            target = (int(time / 0.5) + 1) * 0.5
    if not count:
        raise ValueError("empty video rhythm observations")
    return {"method": "sampled_rgb_v1", "timeBasis": "video_elapsed", "sampleIntervalSeconds": 0.5, "changeThreshold": 0.18, "sampleCount": count,
            "sampledUntilSeconds": until, "changeCount": changes, "changeTimes": times, "truncated": changes > len(times), "windows": list(windows.values())}
def extract_frames(duration):
    # Keep a few timestamped observations before the caller removes the video.
    # This is sampled evidence, never a claim to have inspected every frame.
    frames = []
    with av.open(str(source), mode="r", options={"protocol_whitelist": "file", "format_whitelist": "mov,matroska,webm,mp3,wav,ogg,aac,flac", "probesize": "8388608"}) as container:
        if container.streams.video:
            video = container.streams.video[0]
            if video.width * video.height > 32000000 or not video.time_base:
                raise ValueError("unsupported video dimensions or timestamps")
            video.thread_count = 1
            targets = sorted(set([0, min(3, duration / 4), duration / 2, max(0, duration - 2)]))
            for target in targets:
                container.seek(int(target / video.time_base), stream=video, backward=True)
                captured = False
                for index, frame in enumerate(container.decode(video=0)):
                    if index >= 1000:
                        raise ValueError("keyframe decode budget exceeded")
                    if frame.time is None or frame.time + 0.001 < target:
                        continue
                    if frame.time > duration + 0.1:
                        break
                    scale = min(640 / frame.width, 360 / frame.height, 1)
                    resized = frame.reformat(width=max(1, int(frame.width * scale)), height=max(1, int(frame.height * scale)), format="rgb24", threads=1)
                    encoder = av.CodecContext.create("png", "w")
                    encoder.width, encoder.height = resized.width, resized.height
                    encoder.pix_fmt, encoder.thread_count = "rgb24", 1
                    encoder.time_base = Fraction(1, 1)
                    resized.pts, resized.time_base = 0, Fraction(1, 1)
                    png = b"".join(bytes(packet) for packet in [*encoder.encode(resized), *encoder.encode(None)])
                    if len(png) > 1000000:
                        raise ValueError("keyframe bytes limit")
                    frames.append({"timeSeconds": float(frame.time), "pngBase64": base64.b64encode(png).decode("ascii")})
                    captured = True
                    break
                if not captured:
                    raise ValueError("required keyframe unavailable")
    return frames

error = "local_asr_failed"
stage = "imports"
try:
    import av
    import numpy as np
    if frames_only:
        stage = "keyframes"
        if not source.is_file():
            raise ValueError("missing local input")
        duration = media_duration()
        audio_rhythm = AudioRhythm()
        for chunk in decoded_audio():
            audio_rhythm.add(chunk)
        result = {"durationSeconds": duration, "frames": extract_frames(duration), "rhythm": {"version": 1, "audio": audio_rhythm.finish(), "visual": visual_rhythm(duration)}}
        if not result["frames"]:
            raise ValueError("required keyframes unavailable")
    else:
        from faster_whisper import WhisperModel
        stage = "inputs"
        if not source.is_file() or not all((model_dir / name).is_file() for name in ["model.bin", "config.json", "tokenizer.json", "vocabulary.json"]):
            raise ValueError("missing local input or model")
        error = "unsupported_media"
        stage = "decode"
        chunks, samples, audio_rhythm = [], 0, AudioRhythm()
        for chunk in decoded_audio(required=True):
            chunks.append(chunk)
            samples += chunk.size
            audio_rhythm.add(chunk)
        if not chunks or not samples:
            raise ValueError("empty audio")
        audio = np.concatenate(chunks)
        del chunks
        duration = media_duration(samples / 16000)
        stage = "keyframes"
        frames = extract_frames(duration)
        error = "local_asr_failed"
        stage = "model_load"
        model = WhisperModel(str(model_dir), device="cpu", compute_type="int8", cpu_threads=2, num_workers=1, local_files_only=True)
        stage = "recognition"
        segments, info = model.transcribe(audio, beam_size=5, vad_filter=False, word_timestamps=False)
        result = {"language": info.language, "durationSeconds": duration,
                  "model": "faster-whisper-large-v3-turbo@846f747/int8", "segments": [],
                  "rhythm": {"version": 1, "audio": audio_rhythm.finish(), "visual": visual_rhythm(duration)}}
        if frames:
            result["frames"] = frames
        for segment in segments:
            text = segment.text.strip()
            if text:
                result["segments"].append({"start": segment.start, "end": segment.end, "text": text})
            if len(result["segments"]) > 20000 or sum(len(item["text"]) for item in result["segments"]) > 200000:
                raise ValueError("transcript output limit")
        if not result["segments"]:
            error = "no_speech"
            raise ValueError("no recognized speech")
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    payload = json.dumps({"sourceSha256": digest.hexdigest(), "modelSha256": sys.argv[4], ("visuals" if frames_only else "recognition"): result}, ensure_ascii=False).encode("utf-8")
    if len(payload) > maximum_output_bytes:
        raise ValueError("transcript bytes limit")
except Exception as exception:
    kind = type(exception).__name__
    reason = "allocation_failed" if isinstance(exception, MemoryError) or "alloc" in str(exception).lower() else "other"
    payload = json.dumps({"error": error, "stage": stage, "reason": reason, "kind": kind if kind in ["MemoryError", "RuntimeError", "ValueError", "FileNotFoundError", "InvalidDataError", "PermissionError"] else "other"}).encode("utf-8")
    failed = True
else:
    failed = False

partial = output.with_suffix(".part")
if partial.is_symlink() or partial.stat().st_size != maximum_output_bytes:
    raise RuntimeError("reserved result buffer unavailable")
with partial.open("r+b") as stream:
    stream.write(payload)
    stream.truncate(len(payload))
    stream.flush()
    os.fsync(stream.fileno())
if not failed:
    os.replace(partial, output)
sys.exit(2 if failed else 0)
