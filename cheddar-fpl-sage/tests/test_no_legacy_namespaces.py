from pathlib import Path

BANNED = [
    "fpl_sage_optimized",
    "from analysis.",
    "from collectors.",
    "from validation.",
    "from models.",
    "from pipelines.",
    "from rules.",
    "from storage.",
    "from transformers.",
    "from utils.",
    "import analysis",
    "import collectors",
    "import validation",
    "import models",
    "import pipelines",
    "import rules",
    "import storage",
    "import transformers",
    "import utils",
]

IGNORED_PATH_PARTS = {
    "venv",
    ".venv",
    "site-packages",
    "__pycache__",
}


def test_no_legacy_namespace_imports():
    root = Path(__file__).resolve().parents[1]
    guard_file = Path(__file__).resolve()
    offenders = []
    for p in root.rglob("*.py"):
        if p == guard_file:
            continue
        if any(part in IGNORED_PATH_PARTS for part in p.parts):
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        for token in BANNED:
            if token in text:
                offenders.append((str(p), token))
    assert not offenders, "Legacy namespace usage found:\n" + "\n".join(
        f"{p} -> {t}" for p, t in offenders
    )
