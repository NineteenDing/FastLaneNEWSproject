"""Eight-second lossless boundary fixture: known tones/quiet and four flat panels."""
import io
import sys
from fractions import Fraction
import av
import numpy as np

speech = None
if len(sys.argv) > 1:
    chunks = []
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    with av.open(sys.argv[1], mode="r") as recording:
        for frame in recording.decode(audio=0):
            chunks.extend(converted.to_ndarray().reshape(-1) for converted in resampler.resample(frame))
    chunks.extend(converted.to_ndarray().reshape(-1) for converted in resampler.resample(None))
    speech = np.concatenate(chunks)[:96000]
    assert speech.size == 96000
output = io.BytesIO()
with av.open(output, mode="w", format="matroska") as container:
    video = container.add_stream("ffv1", rate=10)
    video.width, video.height, video.pix_fmt = 160, 90, "yuv420p"
    stream = container.add_stream("pcm_s16le", rate=16000)
    stream.layout = "mono"
    colors = [(0, 0, 0), (255, 255, 255), (0, 255, 0), (255, 0, 0)]
    for index in range(80):
        pixels = np.empty((90, 160, 3), dtype=np.uint8)
        pixels[:] = colors[index // 20]
        frame = av.VideoFrame.from_ndarray(pixels, format="rgb24")
        frame.pts, frame.time_base = index, Fraction(1, 10)
        for packet in video.encode(frame):
            container.mux(packet)
    for packet in video.encode(None):
        container.mux(packet)
    for second in range(6 if speech is not None else 8):
        samples = speech[second * 16000:(second + 1) * 16000] if speech is not None else (
            (np.sin(2 * np.pi * 440 * np.arange(16000) / 16000) * 8000).astype(np.int16) if second in (0, 2, 6) else np.zeros(16000, dtype=np.int16))
        frame = av.AudioFrame.from_ndarray(samples.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate, frame.pts, frame.time_base = 16000, second * 16000, Fraction(1, 16000)
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
sys.stdout.buffer.write(output.getvalue())
