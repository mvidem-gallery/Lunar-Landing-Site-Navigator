"""Convert NASA LOLA LDEM_16 to a compact global 8 pixels/degree grid."""
import gzip
import urllib.request
from pathlib import Path
import numpy as np

URL = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_16.img"

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        raw = Path(sys.argv[1]).read_bytes()
    else:
        with urllib.request.urlopen(URL, timeout=60) as response:
            raw = response.read()
    pixels = np.frombuffer(raw, dtype="<i2").reshape(1440, 2, 2880, 2)
    reduced = np.rint(pixels.mean(axis=(1, 3)) / 2).astype("<i2")
    # Reset prediction at every row. Delta coding improves gzip compression.
    deltas = np.diff(reduced, axis=1, prepend=np.zeros((1440, 1), dtype="<i2"))
    Path("data/global-dem.bin").write_bytes(gzip.compress(deltas.tobytes(), mtime=0))
