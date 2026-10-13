import hashlib
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import pytest

from stoned_mango import datasets
from stoned_mango.evaluate import _parse_key


@pytest.mark.parametrize("text,expected", [
    ("A minor", (9, "minor")),
    ("d minor\t2\t", (2, "minor")),
    ("Eb major", (3, "major")),
    ("-\t0", None),
    ("F minor / G# major\t1", None),
])
def test_parse_key(text, expected):
    assert _parse_key(text) == expected


@pytest.fixture
def server(tmp_path):
    served = tmp_path / "served"
    served.mkdir()
    handler = partial(SimpleHTTPRequestHandler, directory=str(served))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield served, f"http://127.0.0.1:{httpd.server_address[1]}/"
    httpd.shutdown()


def test_download_uses_backup_skips_good_files_and_reports_failures(tmp_path, server, monkeypatch):
    served, url = server
    root = tmp_path / "data" / "fake-dataset"
    (root / "annotations").mkdir(parents=True)
    (root / "md5").mkdir()
    good = b"\xff\xfb" + bytes(20_000)
    (served / "backup").mkdir()
    (served / "backup" / "1.LOFI.mp3").write_bytes(good)  # only on the backup mirror
    (root / "md5" / "1.LOFI.md5").write_text(hashlib.md5(good).hexdigest())
    (root / "md5" / "2.LOFI.md5").write_text("0" * 32)  # exists nowhere
    monkeypatch.setitem(datasets.DATASETS, "fake", {"repo": "unused", "dir": "fake-dataset",
                                                    "urls": [url + "missing/", url + "backup/"]})
    datasets.download("fake", tmp_path / "data", workers=2)
    assert (root / "audio" / "1.LOFI.mp3").read_bytes() == good
    assert not (root / "audio" / "2.LOFI.mp3").exists()
    # A second run keeps the verified file without fetching it again.
    (served / "backup" / "1.LOFI.mp3").unlink()
    datasets.download("fake", tmp_path / "data", workers=2)
    assert (root / "audio" / "1.LOFI.mp3").read_bytes() == good
