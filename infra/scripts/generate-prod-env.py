#!/usr/bin/env python3
"""Génère /home/deployer/docupro-demo.env (mode 600) depuis infra/.env.example.

Idempotent : si le fichier existe déjà, il n'est pas modifié.
Les secrets ne sont jamais imprimés.
"""
from __future__ import annotations

import os
import secrets
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "infra" / ".env.example"
DEST = Path(os.environ.get("DOCUPRO_ENV_FILE", "/home/deployer/docupro-demo.env"))


def main() -> int:
    if not EXAMPLE.is_file():
        print(f"missing {EXAMPLE}", file=sys.stderr)
        return 1

    if DEST.exists():
        mode = stat.S_IMODE(DEST.stat().st_mode)
        print(f"already exists: {DEST} mode={mode:o} (left untouched)")
        if mode & 0o077:
            print(f"WARNING: {DEST} is readable by group/other — expected 600", file=sys.stderr)
        text = DEST.read_text(encoding="utf-8")
        if any(
            line.startswith(prefix) and any(bad in line for bad in ("change-me-please", "29122003", "CHANGE_ME_GENERATE"))
            for line in text.splitlines()
            for prefix in ("JWT_SECRET=", "POSTGRES_PASSWORD=", "DATABASE_URL=", "SCAN_AGENT_API_KEY=")
        ):
            print(
                f"ERROR: {DEST} still contains a placeholder or development secret",
                file=sys.stderr,
            )
            return 1
        return 0

    pg = secrets.token_hex(24)
    jwt = secrets.token_hex(32)
    scan = secrets.token_hex(24)
    text = EXAMPLE.read_text(encoding="utf-8")
    replacements = (
        ("POSTGRES_PASSWORD=CHANGE_ME_GENERATE", f"POSTGRES_PASSWORD={pg}"),
        (
            "postgresql://docupro:CHANGE_ME_GENERATE@docupro-demo-postgres:5432/DocuPro?schema=public",
            f"postgresql://docupro:{pg}@docupro-demo-postgres:5432/DocuPro?schema=public",
        ),
        ("JWT_SECRET=CHANGE_ME_GENERATE", f"JWT_SECRET={jwt}"),
        ("SCAN_AGENT_API_KEY=CHANGE_ME_GENERATE", f"SCAN_AGENT_API_KEY={scan}"),
    )
    for old, new in replacements:
        if old not in text:
            print(f"placeholder not found in example: {old.split('=')[0]}", file=sys.stderr)
            return 1
        text = text.replace(old, new, 1)
    if "CHANGE_ME_GENERATE" in text:
        print("unreplaced CHANGE_ME_GENERATE remains in generated env", file=sys.stderr)
        return 1

    DEST.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(str(DEST), flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.chmod(DEST, 0o600)
    print(f"wrote {DEST} mode=600 (contents not printed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
