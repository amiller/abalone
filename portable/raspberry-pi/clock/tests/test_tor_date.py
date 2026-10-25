# SPDX-License-Identifier: MIT
import importlib.util
from pathlib import Path
import unittest
s = importlib.util.spec_from_file_location('tor_date', Path(__file__).resolve().parents[1] / 'tor-date.py')
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
HEADER = b'HTTP/2 404 \r\nDate: Thu, 15 Oct 2026 22:39:33 GMT\r\n\r\n'
class DateTest(unittest.TestCase):
    def test_status_and_date(self):
        self.assertEqual(m.parse_headers(HEADER), 1792103973)
        self.assertEqual(m.parse_headers(HEADER.replace(b'404', b'200')), 1792103973)
    def test_invalid(self):
        for raw in (HEADER.replace(b'404', b'403'), HEADER.replace(b'GMT', b'UTC'), HEADER.replace(b'Thu', b'Fri'), HEADER + b'Date: Thu, 15 Oct 2026 22:39:33 GMT\r\n', b'x'*8193, b'HTTP/2 200\r\n\r\n'):
            with self.assertRaises(ValueError):m.parse_headers(raw)
    def test_forward_only_bounds(self):
        self.assertIsNone(m.correction(100,105))
        self.assertIsNone(m.correction(100,100))
        self.assertEqual(m.correction(101,100),101)
        for remote,local in ((100,106),(100+m.MAX_FORWARD+1,100)):
            with self.assertRaises(ValueError):m.correction(remote,local)
if __name__ == '__main__':unittest.main()
