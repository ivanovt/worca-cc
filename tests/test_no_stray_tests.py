"""Meta-test: no collectable pytest items should exist under src/.

Production modules whose names happen to match pytest's collection pattern
(test_*.py) are allowlisted — they are never collected because
testpaths = ["tests"] in pyproject.toml.
"""

import subprocess
import sys

ALLOWLISTED = {
    "src/worca/hooks/test_gate.py",
    "src/worca/workspace/integration_test.py",
}


def test_no_stray_tests_under_src():
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "src/"],
        capture_output=True,
        text=True,
    )
    if result.returncode == 5:
        return  # exit code 5 = no tests collected — exactly what we want

    lines = result.stdout.strip().splitlines()
    collected = [
        line for line in lines
        if "::" in line
        and not any(line.startswith(a + "::") for a in ALLOWLISTED)
    ]
    assert not collected, (
        f"Found {len(collected)} collectable test(s) under src/ that are not "
        f"in the CI-collected tests/ tree:\n" + "\n".join(collected)
    )
