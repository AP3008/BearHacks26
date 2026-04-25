from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv


@dataclass(frozen=True)
class CreateAssistantArgs:
    env_path: Path
    name: str
    system_prompt: str
    base_url: str
    api_key: str
    timeout_s: float
    embedding_provider: str
    embedding_model_name: str
    embedding_dims: int | None


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Create a Backboard.io assistant and write its id into backend/.env")
    p.add_argument("--env", default=str(Path(__file__).resolve().parents[1] / ".env"))
    p.add_argument("--name", default="Autonomy")
    p.add_argument(
        "--system-prompt",
        default="You are a helpful assistant for a developer tool. Be concise and accurate.",
    )
    p.add_argument(
        "--embedding-provider",
        default=os.getenv("BACKBOARD_EMBEDDING_PROVIDER", ""),
        help="Embedding provider to use (e.g. openai, google, cohere). Can also set BACKBOARD_EMBEDDING_PROVIDER.",
    )
    p.add_argument(
        "--embedding-model-name",
        default=os.getenv("BACKBOARD_EMBEDDING_MODEL_NAME", ""),
        help="Embedding model name (e.g. text-embedding-3-large). Can also set BACKBOARD_EMBEDDING_MODEL_NAME.",
    )
    p.add_argument(
        "--embedding-dims",
        default=os.getenv("BACKBOARD_EMBEDDING_DIMS", ""),
        help="Embedding dimensions (e.g. 3072). Can also set BACKBOARD_EMBEDDING_DIMS.",
    )
    p.add_argument("--timeout-s", type=float, default=float(os.getenv("BACKBOARD_HTTP_TIMEOUT_S", "30")))
    return p.parse_args()


def _build_create_args(*, cli: argparse.Namespace) -> CreateAssistantArgs:
    env_path = Path(cli.env).expanduser().resolve()
    load_dotenv(env_path, override=False)

    api_key = (os.getenv("BACKBOARD_API_KEY", "") or "").strip()
    if not api_key:
        raise SystemExit(f"Missing BACKBOARD_API_KEY. Set it in `{env_path}` (or your environment) and retry.")

    base_url = (os.getenv("BACKBOARD_API_URL", "") or "").strip() or "https://app.backboard.io/api"
    base_url = base_url.rstrip("/")

    embedding_provider = (getattr(cli, "embedding_provider", "") or "").strip()
    embedding_model_name = (getattr(cli, "embedding_model_name", "") or "").strip()
    embedding_dims_raw = (getattr(cli, "embedding_dims", "") or "").strip()
    embedding_dims: int | None
    if embedding_dims_raw:
        try:
            embedding_dims = int(embedding_dims_raw)
        except ValueError:
            raise SystemExit(f"Invalid --embedding-dims: {embedding_dims_raw!r} (expected integer)")
    else:
        embedding_dims = None

    return CreateAssistantArgs(
        env_path=env_path,
        name=str(cli.name).strip() or "Autonomy",
        system_prompt=str(cli.system_prompt).strip(),
        base_url=base_url,
        api_key=api_key,
        timeout_s=float(cli.timeout_s),
        embedding_provider=embedding_provider,
        embedding_model_name=embedding_model_name,
        embedding_dims=embedding_dims,
    )


def _create_backboard_assistant(*, args: CreateAssistantArgs) -> dict[str, Any]:
    url = f"{args.base_url}/assistants"
    payload: dict[str, Any] = {"name": args.name, "system_prompt": args.system_prompt}
    if args.embedding_provider:
        payload["embedding_provider"] = args.embedding_provider
    if args.embedding_model_name:
        payload["embedding_model_name"] = args.embedding_model_name
    if args.embedding_dims is not None:
        payload["embedding_dims"] = args.embedding_dims
    with httpx.Client(
        headers={"X-API-Key": args.api_key},
        timeout=args.timeout_s,
    ) as c:
        resp = c.post(url, json=payload)

    if resp.status_code not in (200, 201):
        body = (resp.text or "").strip()
        raise SystemExit(f"Backboard create assistant failed: HTTP {resp.status_code}: {body[:800]}")

    data = resp.json()
    if not isinstance(data, dict):
        raise SystemExit(f"Unexpected response shape: {type(data)}")
    return data


def _upsert_env_kv(*, env_text: str, key: str, value: str) -> str:
    lines = env_text.splitlines()
    updated: list[str] = []
    did_set = False

    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            updated.append(line)
            continue
        if not line.startswith(f"{key}="):
            updated.append(line)
            continue

        updated.append(f"{key}={value}")
        did_set = True

    if not did_set:
        if updated and updated[-1].strip():
            updated.append("")
        updated.append(f"{key}={value}")

    return "\n".join(updated) + ("\n" if env_text.endswith("\n") or not env_text else "")


def _write_assistant_id_to_env(*, env_path: Path, assistant_id: str) -> None:
    if not env_path.exists():
        raise SystemExit(f"Env file not found: `{env_path}`")

    prior = env_path.read_text(encoding="utf-8")
    next_text = _upsert_env_kv(env_text=prior, key="BACKBOARD_ASSISTANT_ID", value=assistant_id)
    env_path.write_text(next_text, encoding="utf-8")


def main() -> None:
    cli = _parse_args()
    args = _build_create_args(cli=cli)

    assistant = _create_backboard_assistant(args=args)
    assistant_id = assistant.get("assistant_id") or assistant.get("id")
    if not isinstance(assistant_id, str) or not assistant_id.strip():
        raise SystemExit(f"Backboard response missing assistant_id. Keys={list(assistant.keys())}")

    assistant_id = assistant_id.strip()
    _write_assistant_id_to_env(env_path=args.env_path, assistant_id=assistant_id)

    print(assistant_id)


if __name__ == "__main__":
    main()

