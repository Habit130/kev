"""Offline availability handling for declared private mirrors (synthetic inputs only)."""

import hashlib
import socket
from pathlib import Path

import huggingface_hub
import pytest
from huggingface_hub.errors import LocalEntryNotFoundError, OfflineModeIsEnabled

from kev import suite
from scripts import private_rows


def _offline_miss():
    error = LocalEntryNotFoundError("synthetic uncached input")
    error.__cause__ = OfflineModeIsEnabled("synthetic offline sentinel")
    return error


def _local_miss():
    return LocalEntryNotFoundError("synthetic missing local entry")


@pytest.fixture(autouse=True)
def _block_network(monkeypatch):
    def fail_network(*args, **kwargs):
        pytest.fail("synthetic private-input tests must not open network sockets")

    monkeypatch.setattr(socket.socket, "connect", fail_network)
    monkeypatch.setattr(socket.socket, "connect_ex", fail_network)


def _install_hub(monkeypatch, outcome):
    calls = []

    def download(repo, filename, **kwargs):
        calls.append((repo, filename, kwargs))
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(huggingface_hub, "hf_hub_download", download)
    return calls


def _write_suite(root, mirror, expected):
    directory = Path(root) / "evals" / "synthetic-private-v1"
    directory.mkdir(parents=True)
    manifest = {
        "files": {
            "development.jsonl": {
                "sha256": hashlib.sha256(expected).hexdigest(),
                "records": 1,
            }
        }
    }
    if mirror is not None:
        manifest["mirror"] = mirror
    suite.write_json(directory / "manifest.json", manifest)
    return directory


def _rows_manifest(root, *, dataset=private_rows.DATASET, expected=b'{"synthetic":true}\n'):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / "private-rows.json"
    target = root / "runs" / "synthetic" / "rows.jsonl"
    suite.write_json(
        manifest_path,
        {
            "dataset": dataset,
            "revision": "a" * 40,
            "files": [
                {
                    "path": "runs/synthetic/rows.jsonl",
                    "private_path": "runs/r99/synthetic/rows.jsonl",
                    "sha256": hashlib.sha256(expected).hexdigest(),
                }
            ],
        },
    )
    return manifest_path, target


def test_private_suite_offline_uncached_partition_uses_optional_permission_signal(tmp_path, monkeypatch):
    expected = b'{"synthetic":true}\n'
    directory = _write_suite(
        tmp_path,
        {"dataset": suite.PRIVATE_DATASET, "revision": "b" * 40},
        expected,
    )
    failure = _offline_miss()
    calls = _install_hub(monkeypatch, failure)

    with pytest.raises(PermissionError, match=suite.PRIVATE_DATASET) as caught:
        suite.load_split(directory, "development")

    assert caught.value.__cause__ is failure
    assert len(calls) == 1
    assert calls[0][0:2] == (suite.PRIVATE_DATASET, "synthetic-private-v1/development.jsonl")
    assert calls[0][2] == {"repo_type": "dataset", "revision": "b" * 40}
    assert not (directory / "development.jsonl").exists()


@pytest.mark.parametrize(
    "mirror",
    [
        None,
        {"dataset": "example/unknown-private-mirror", "revision": "c" * 40},
    ],
)
def test_public_or_unrecognized_suite_mirror_keeps_offline_failure(tmp_path, monkeypatch, mirror):
    directory = _write_suite(tmp_path, mirror, b'{"synthetic":true}\n')
    failure = _offline_miss()
    calls = _install_hub(monkeypatch, failure)

    with pytest.raises(LocalEntryNotFoundError) as caught:
        suite.load_split(directory, "development")

    assert caught.value is failure
    assert len(calls) == 1
    expected_repo = mirror["dataset"] if mirror else suite.SUITES_DATASET
    assert calls[0][0] == expected_repo


def test_private_suite_nonoffline_local_miss_keeps_original_error(tmp_path, monkeypatch):
    directory = _write_suite(
        tmp_path,
        {"dataset": suite.PRIVATE_DATASET, "revision": "b" * 40},
        b'{"synthetic":true}\n',
    )
    failure = _local_miss()
    _install_hub(monkeypatch, failure)

    with pytest.raises(LocalEntryNotFoundError) as caught:
        suite.load_split(directory, "development")

    assert caught.value is failure


def test_private_suite_local_and_hub_cache_hits_still_pass_manifest_checks(tmp_path, monkeypatch, capsys):
    expected = b'{"synthetic":true}\n'
    local_dir = _write_suite(
        tmp_path / "local",
        {"dataset": suite.PRIVATE_DATASET, "revision": "b" * 40},
        expected,
    )
    (local_dir / "development.jsonl").write_bytes(expected)

    def forbidden(*args, **kwargs):
        pytest.fail("a present local partition must not access the Hub")

    calls = _install_hub(monkeypatch, forbidden)
    records = suite.load_split(local_dir, "development")
    assert records == [{"synthetic": True}]
    assert calls == []

    cache_dir = _write_suite(
        tmp_path / "cached",
        {"dataset": suite.PRIVATE_DATASET, "revision": "b" * 40},
        expected,
    )
    cache_file = tmp_path / "synthetic-hf-cache" / "rows.jsonl"
    cache_file.parent.mkdir()
    cache_file.write_bytes(expected)
    calls = _install_hub(monkeypatch, cache_file)

    assert suite.load_split(cache_dir, "development") == records
    assert len(calls) == 1
    assert (cache_dir / "development.jsonl").read_bytes() == expected
    assert "fetched synthetic-private-v1/development.jsonl" in capsys.readouterr().out


def test_private_suite_corrupt_cached_bytes_keep_checksum_failure(tmp_path, monkeypatch):
    expected = b'{"synthetic":true}\n'
    directory = _write_suite(
        tmp_path,
        {"dataset": suite.PRIVATE_DATASET, "revision": "b" * 40},
        expected,
    )
    cache_file = tmp_path / "synthetic-hf-cache.jsonl"
    cache_file.write_bytes(b'{"synthetic":false}\n')
    _install_hub(monkeypatch, cache_file)

    with pytest.raises(ValueError, match="suite checksum mismatch"):
        suite.load_split(directory, "development")


def test_private_rows_offline_uncached_file_uses_optional_permission_signal(tmp_path, monkeypatch):
    manifest, target = _rows_manifest(tmp_path)
    failure = _offline_miss()
    calls = _install_hub(monkeypatch, failure)

    with pytest.raises(PermissionError, match=private_rows.DATASET) as caught:
        private_rows.restore(manifest.name, tmp_path)

    assert caught.value.__cause__ is failure
    assert len(calls) == 1
    assert calls[0][0:2] == (private_rows.DATASET, "runs/r99/synthetic/rows.jsonl")
    assert calls[0][2] == {"repo_type": "dataset", "revision": "a" * 40}
    assert not target.exists()


@pytest.mark.parametrize("dataset", ["example/unknown-private-mirror", "jaredpalmer/kev-private-evals"])
def test_private_rows_unknown_source_or_nonoffline_miss_keeps_original_error(tmp_path, monkeypatch, dataset):
    manifest, _ = _rows_manifest(tmp_path, dataset=dataset)
    failure = _offline_miss() if dataset != private_rows.DATASET else _local_miss()
    _install_hub(monkeypatch, failure)

    with pytest.raises(LocalEntryNotFoundError) as caught:
        private_rows.restore(manifest.name, tmp_path)

    assert caught.value is failure


def test_private_rows_local_and_cached_inputs_still_use_hash_verified_restore(tmp_path, monkeypatch):
    expected = b'{"synthetic":true}\n'
    manifest, target = _rows_manifest(tmp_path / "local", expected=expected)
    target.parent.mkdir(parents=True)
    target.write_bytes(expected)

    def forbidden(*args, **kwargs):
        pytest.fail("a valid local private-row file must not access the Hub")

    calls = _install_hub(monkeypatch, forbidden)
    assert private_rows.restore(manifest.name, manifest.parent) == []
    assert calls == []

    manifest, target = _rows_manifest(tmp_path / "cached", expected=expected)
    cache_file = tmp_path / "synthetic-row-cache.jsonl"
    cache_file.write_bytes(expected)
    calls = _install_hub(monkeypatch, cache_file)

    assert private_rows.restore(manifest.name, manifest.parent) == ["runs/synthetic/rows.jsonl"]
    assert len(calls) == 1
    assert target.read_bytes() == expected
    assert suite.digest(target) == hashlib.sha256(expected).hexdigest()


def test_private_rows_corrupt_cache_bytes_keep_hash_failure(tmp_path, monkeypatch):
    manifest, target = _rows_manifest(tmp_path)
    cache_file = tmp_path / "synthetic-row-cache.jsonl"
    cache_file.write_bytes(b'{"synthetic":false}\n')
    _install_hub(monkeypatch, cache_file)

    with pytest.raises(ValueError, match="does not match the manifest's sha256"):
        private_rows.restore(manifest.name, tmp_path)

    assert not target.exists()


def test_private_rows_does_not_hide_corrupt_local_target_when_offline(tmp_path, monkeypatch):
    manifest, target = _rows_manifest(tmp_path)
    target.parent.mkdir(parents=True)
    target.write_bytes(b'{"synthetic":false}\n')
    failure = _offline_miss()
    _install_hub(monkeypatch, failure)

    with pytest.raises(LocalEntryNotFoundError) as caught:
        private_rows.restore(manifest.name, tmp_path)

    assert caught.value is failure
    assert target.read_bytes() == b'{"synthetic":false}\n'


def test_unrelated_hub_errors_propagate_without_permission_reclassification(tmp_path, monkeypatch):
    directory = _write_suite(
        tmp_path / "suite",
        {"dataset": suite.PRIVATE_DATASET, "revision": "b" * 40},
        b'{"synthetic":true}\n',
    )
    manifest, _ = _rows_manifest(tmp_path / "rows")
    failure = RuntimeError("synthetic unrelated Hub failure")
    _install_hub(monkeypatch, failure)

    with pytest.raises(RuntimeError, match="synthetic unrelated Hub failure"):
        suite.load_split(directory, "development")
    with pytest.raises(RuntimeError, match="synthetic unrelated Hub failure"):
        private_rows.restore(manifest.name, manifest.parent)
