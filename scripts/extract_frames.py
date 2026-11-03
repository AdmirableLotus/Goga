#!/usr/bin/env python
"""
extract_frames.py — sample still frames from a video for the vision model to read.

Usage: python extract_frames.py <media_path> <output_dir>

Seeks to evenly-spaced timestamps (so a six-hour video isn't fully decoded),
downscales each frame, skips frames nearly identical to the one before (a slide
held on screen), and prints one line per saved frame:

    FRAME <seconds> <path>   (repeated)
    DONE <count>
    ERROR <message>

Env: FRAMES_MAX (default 150), FRAMES_MIN_INTERVAL seconds (default 45),
FRAME_WIDTH px (default 768).
"""
import os
import sys


def emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def diag(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def main() -> int:
    if len(sys.argv) < 3:
        emit("ERROR usage: extract_frames.py <media> <output_dir>")
        return 2
    media, out_dir = sys.argv[1], sys.argv[2]
    if not os.path.isfile(media):
        emit(f"ERROR file not found: {media}")
        return 2
    os.makedirs(out_dir, exist_ok=True)

    max_frames = int(os.environ.get("FRAMES_MAX", "150"))
    min_interval = float(os.environ.get("FRAMES_MIN_INTERVAL", "45"))
    width = int(os.environ.get("FRAME_WIDTH", "768"))

    try:
        import av
        from PIL import Image
    except Exception as e:
        emit(f"ERROR imaging libraries unavailable: {e}")
        return 1

    try:
        container = av.open(media)
    except Exception as e:
        emit(f"ERROR could not open the video: {e}")
        return 1

    if not container.streams.video:
        emit("ERROR that file has no video track")
        container.close()
        return 1

    stream = container.streams.video[0]
    duration = float(container.duration) / 1_000_000.0 if container.duration else 0.0
    if duration <= 0:
        duration = float(stream.duration * stream.time_base) if stream.duration else 0.0

    # Evenly spaced times, at least min_interval apart, capped at max_frames.
    if duration <= 0:
        times = [0.0]
    else:
        n = max(1, min(max_frames, int(duration // min_interval) + 1))
        step = duration / n
        times = [min(duration - 0.5, step * (i + 0.5)) for i in range(n)]

    def signature(img) -> bytes:
        return img.convert("L").resize((16, 16)).tobytes()

    def differs(a, b, threshold=1.5) -> bool:
        # Skip only a near-identical frame (a slide held on screen); any text change passes.
        if a is None or b is None:
            return True
        diff = sum(abs(x - y) for x, y in zip(a, b)) / len(a)
        return diff > threshold

    saved = 0
    prev_sig = None
    try:
        for t in times:
            if saved >= max_frames:
                break
            try:
                container.seek(int(t * 1_000_000), backward=True, any_frame=False)
                # Decode forward to the target time: with sparse keyframes a seek lands earlier,
                # so advance until a frame at/after t (capped so we never scan the whole file).
                frame = None
                for scanned, fr in enumerate(container.decode(video=0)):
                    frame = fr
                    if (fr.time is not None and fr.time >= t - 0.5) or scanned >= 600:
                        break
                if frame is None:
                    continue
            except (StopIteration, av.AVError):
                continue
            img = frame.to_image()
            if img.width > width:
                img = img.resize((width, int(img.height * width / img.width)))
            sig = signature(img)
            if not differs(prev_sig, sig):
                continue  # a near-duplicate of the last slide — skip it
            prev_sig = sig
            secs = int(frame.time if frame.time is not None else t)
            path = os.path.join(out_dir, f"f_{secs:06d}.jpg")
            img.save(path, "JPEG", quality=80)
            emit(f"FRAME {secs} {path}")
            saved += 1
    except Exception as e:
        diag(f"frame loop error: {e}")
    finally:
        container.close()

    emit(f"DONE {saved}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
