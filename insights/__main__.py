"""Command line: python -m insights <command>. See OWNER_NOTES.md, "Class insights"."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / "raw" / "insights"  # gitignored working cache
SNAP = DATA / "insights" / "raw"  # committed compact snapshots


def course_ids() -> list[str]:
    return [c["id"] for c in json.loads((DATA / "courses.json").read_text(encoding="utf-8"))]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m insights", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("collect-berkeleytime", help="fetch grades, ratings, reviews, exams for every course (resumable)")
    p.add_argument("--rate", type=float, default=3.0, help="requests per second, all workers together")
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--only", nargs="*", help="course ids, default all of data/courses.json")
    sub.add_parser("refresh-queries", help="re-read Berkeleytime query texts from the site bundle")
    p = sub.add_parser("collect-rmp", help="fetch every Berkeley professor from RateMyProfessors")
    p.add_argument("--reviews", type=int, default=0, help="also fetch written reviews for the N most-rated professors")
    p = sub.add_parser("collect-reddit", help="search r/berkeley for the most popular courses")
    p.add_argument("--top", type=int, default=300)
    sub.add_parser("pack", help="pack the working cache into the committed snapshots")
    p = sub.add_parser("summary-bundles", help="write review bundles for a model to summarize")
    p.add_argument("dir", type=Path)
    p = sub.add_parser("summary-merge", help="merge model output files (out_*.json) into data/insights/summaries.json")
    p.add_argument("dir", type=Path)
    p = sub.add_parser("build", help="compute ratings and write data/insights/")
    p.add_argument("--check", action="store_true", help="fail if the output would change")
    args = ap.parse_args(argv)

    if args.cmd == "collect-berkeleytime":
        from . import berkeleytime as bt

        bt.collect_all(args.only or course_ids(), CACHE / "bt", workers=args.workers, rate=args.rate)
    elif args.cmd == "refresh-queries":
        import re

        import requests

        from . import berkeleytime as bt

        html = requests.get(bt.SITE_URL, headers={"User-Agent": bt.USER_AGENT}, timeout=30).text
        found: dict[str, str] = {}
        for src in sorted(set(re.findall(r"assets/[^\"']+\.js", html))):
            js = requests.get(f"{bt.SITE_URL}/{src}", headers={"User-Agent": bt.USER_AGENT}, timeout=120).text
            found.update(bt.extract_queries(js, bt.load_queries().keys()))
        missing = set(bt.load_queries()) - set(found)
        if missing:
            raise SystemExit(f"not found in bundle: {sorted(missing)}")
        bt.QUERIES_PATH.write_text(json.dumps(found, indent=1), encoding="utf-8")
        print(f"updated {len(found)} queries")
    elif args.cmd == "collect-rmp":
        from . import rmp

        rmp.collect(CACHE / "rmp", reviews_for_top=args.reviews)
    elif args.cmd == "collect-reddit":
        from . import build, reddit

        reddit.collect(build.popular_courses(args.top), CACHE / "reddit")
    elif args.cmd == "pack":
        from . import berkeleytime as bt
        from . import reddit, rmp

        print("berkeleytime:", bt.pack(course_ids(), CACHE / "bt", SNAP / "berkeleytime.jsonl.gz"))
        print("rmp:", rmp.pack(CACHE / "rmp", SNAP))
        print("reddit:", reddit.pack(CACHE / "reddit", SNAP / "reddit.jsonl.gz"))
    elif args.cmd == "summary-bundles":
        from . import build

        args.dir.mkdir(parents=True, exist_ok=True)
        for k, part in enumerate(build.review_bundles()):
            (args.dir / f"bundle_{k}.json").write_text(json.dumps(part, indent=1, ensure_ascii=False), encoding="utf-8")
            print(k, len(part))
    elif args.cmd == "summary-merge":
        from . import build

        print("merged:", build.merge_summaries(sorted(args.dir.glob("out_*.json"))))
    elif args.cmd == "build":
        from . import build

        return build.main(check=args.check)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
