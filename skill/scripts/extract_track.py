#!/usr/bin/env python3
"""Extract the text of one or more Language Transfer transcript tracks.

Works against either a plain-text transcript (preferred — e.g. a project doc
like `complete-spanish-transcript.txt`, one "Track N" heading per line) or the
original PDF (via pdftotext, using in-page headings since the printed table of
contents can't be trusted — it omits at least one track in the 2019 Spanish
edition).

Usage:
  python3 extract_track.py --txt TRANSCRIPT.txt --list
  python3 extract_track.py --txt TRANSCRIPT.txt --tracks 21
  python3 extract_track.py --txt TRANSCRIPT.txt --tracks 21-23,30 --out ./tracks

  python3 extract_track.py --pdf TRANSCRIPT.pdf --list
  python3 extract_track.py --pdf TRANSCRIPT.pdf --tracks 21-23 --out ./tracks
"""

import argparse
import os
import re
import subprocess
import sys

HEADING = re.compile(r"^Track\s+(\d+)\.?$")


def pdf_pages(pdf_path):
    """Return a list of page texts (index 0 == page 1)."""
    try:
        result = subprocess.run(
            ["pdftotext", pdf_path, "-"],
            capture_output=True, text=True, check=True,
        )
    except FileNotFoundError:
        sys.exit("pdftotext not found. Install poppler-utils.")
    except subprocess.CalledProcessError as exc:
        sys.exit(f"pdftotext failed: {exc.stderr.strip()}")
    pages = result.stdout.split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    return pages


def txt_lines(txt_path):
    """Return the transcript file as a list of lines."""
    with open(txt_path, encoding="utf-8") as handle:
        return handle.read().splitlines()


def build_index_from_pages(pages):
    """Map track number -> (first_page, last_page), 1-based inclusive.

    Detects headings from the page bodies rather than the table of contents.
    """
    starts = []
    for i, page in enumerate(pages, start=1):
        for line in page.splitlines()[:6]:
            match = HEADING.fullmatch(line.strip())
            if match:
                starts.append((int(match.group(1)), i))
                break

    index = {}
    for pos, (track, first) in enumerate(starts):
        last = starts[pos + 1][1] - 1 if pos + 1 < len(starts) else len(pages)
        index[track] = (first, last)
    return index


def build_index_from_lines(lines):
    """Map track number -> (first_line, last_line), 0-based, end exclusive.

    A "Track N" heading can appear anywhere on its own line, not just near the
    top of a page — there are no pages in a plain-text transcript.
    """
    starts = []
    for i, line in enumerate(lines):
        match = HEADING.fullmatch(line.strip())
        if match:
            starts.append((int(match.group(1)), i))

    index = {}
    for pos, (track, first) in enumerate(starts):
        last = starts[pos + 1][1] if pos + 1 < len(starts) else len(lines)
        index[track] = (first, last)
    return index


def parse_tracks(spec):
    """Turn '21-23,30' into [21, 22, 23, 30]."""
    wanted = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            lo, hi = chunk.split("-", 1)
            wanted.extend(range(int(lo), int(hi) + 1))
        else:
            wanted.append(int(chunk))
    return sorted(dict.fromkeys(wanted))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--txt", help="path to a plain-text transcript (preferred)")
    parser.add_argument("--pdf", help="path to the transcript PDF")
    parser.add_argument("--tracks", help="e.g. 21 or 21-23,30")
    parser.add_argument("--list", action="store_true", help="print the track index and exit")
    parser.add_argument("--out", help="directory to write track_NN.txt files into")
    args = parser.parse_args()

    if not args.txt and not args.pdf:
        sys.exit("pass --txt TRANSCRIPT.txt (preferred) or --pdf TRANSCRIPT.pdf")
    if args.txt and args.pdf:
        sys.exit("pass only one of --txt or --pdf")

    if args.txt:
        lines = txt_lines(args.txt)
        index = build_index_from_lines(lines)

        def get_text(first, last):
            return "\n".join(lines[first:last]).strip()

        unit_count, unit_name = len(lines), "lines"
    else:
        pages = pdf_pages(args.pdf)
        index = build_index_from_pages(pages)

        def get_text(first, last):
            return "\n".join(pages[first - 1:last])

        unit_count, unit_name = len(pages), "pages"

    if args.list or not args.tracks:
        print(f"{unit_count} {unit_name}, {len(index)} tracks detected")
        for track in sorted(index):
            first, last = index[track]
            if args.txt:
                print(f"Track {track:>3}: lines {first + 1}-{last}")
            else:
                print(f"Track {track:>3}: pages {first}-{last}")
        return

    for track in parse_tracks(args.tracks):
        if track not in index:
            print(f"Track {track}: not found in this transcript", file=sys.stderr)
            continue
        first, last = index[track]
        text = get_text(first, last)
        header = f"===== Track {track} =====\n"
        if args.out:
            os.makedirs(args.out, exist_ok=True)
            path = os.path.join(args.out, f"track_{track:02d}.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(header + text)
            words = len(text.split())
            print(f"Track {track}: ~{words} words -> {path}")
        else:
            print(header + text)


if __name__ == "__main__":
    main()
