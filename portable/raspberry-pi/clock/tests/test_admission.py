import importlib.util
import pathlib
import unittest
p = pathlib.Path(__file__).resolve().parents[1] / 'admission.py'
s = importlib.util.spec_from_file_location('admission', p)
a = importlib.util.module_from_spec(s); s.loader.exec_module(a)

class Admission(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.writes = []
        self.wall = 0
        def setter(value):
            self.writes.append(value); self.wall = value
        self.setup = a.Setup(earliest_utc='2026-10-15T00:40:53Z', latest_utc='2036-10-15T00:40:53Z', elapsed=lambda: self.now, set_seconds=setter, read_seconds=lambda: self.wall)
    def propose(self):
        return self.setup.propose({'utc': '2026-11-01T12:00:00Z'})
    def test_success_is_user_provided_not_verified_and_single_use(self):
        ticket, view = self.propose()
        result = self.setup.confirm(ticket, view['utc'])
        self.assertEqual(result['accuracy'], 'user-provided'); self.assertFalse(result['networkVerified'])
        with self.assertRaises(a.Refusal): self.setup.confirm(ticket, view['utc'])
        self.assertEqual(len(self.writes), 1)
    def test_invalid_dates_offsets_extra_fields_and_range(self):
        for request in [{'utc': v} for v in ['2026-02-30T12:00:00Z', '2026-11-01T12:00:60Z', '2026-11-01T12:00:00+00:00', '２０２６-11-01T12:00:00Z', '2026-10-14T00:00:00Z', '2037-01-01T00:00:00Z']] + [{'utc': '2026-11-01T12:00:00Z', 'uid': 0}]:
            with self.assertRaises(a.Refusal): self.setup.propose(request)
        self.assertFalse(self.writes)
    def test_failed_edit_and_wrong_ticket_invalidate_old_confirmation(self):
        ticket, view = self.propose()
        with self.assertRaises(a.Refusal): self.setup.propose({'utc': 'bad'})
        with self.assertRaises(a.Refusal): self.setup.confirm(ticket, view['utc'])
        ticket, view = self.propose()
        with self.assertRaises(a.Refusal): self.setup.confirm(object(), view['utc'])
        with self.assertRaises(a.Refusal): self.setup.confirm(ticket, view['utc'])
        self.assertFalse(self.writes)
    def test_expiry_includes_suspend_and_wall_clock_does_not_affect_it(self):
        ticket, view = self.propose(); self.now = 60; self.wall = -999999
        with self.assertRaises(a.Refusal): self.setup.confirm(ticket, view['utc'])
        self.assertFalse(self.writes)
    def test_network_start_revokes_ticket_and_offline_does_not_reopen(self):
        ticket, view = self.propose(); self.setup.network_started()
        self.assertTrue(self.setup.work_offline()['terminalAvailable'])
        with self.assertRaises(a.Refusal): self.setup.confirm(ticket, view['utc'])
        with self.assertRaises(a.Refusal): self.propose()
        self.assertFalse(self.writes)
    def test_unknown_after_setter_failure_never_retries(self):
        def fail(value): self.writes.append(value); raise OSError('synthetic failed syscall')
        self.setup.setter = fail; ticket, view = self.propose()
        with self.assertRaises(OSError): self.setup.confirm(ticket, view['utc'])
        self.assertEqual(self.setup.state, 'unknown')
        with self.assertRaises(a.Refusal): self.propose()
        self.assertEqual(len(self.writes), 1)
    def test_readback_mismatch_unknown(self):
        self.setup.reader = lambda: float('nan'); ticket, view = self.propose()
        with self.assertRaises(a.Refusal): self.setup.confirm(ticket, view['utc'])
        self.assertEqual(self.setup.state, 'unknown'); self.assertEqual(len(self.writes), 1)
    def test_reentrant_setter_cannot_confirm_or_start_network(self):
        ticket, view = self.propose()
        def setter(value):
            with self.assertRaises(a.Refusal): self.setup.confirm(ticket, view['utc'])
            with self.assertRaises(a.Refusal): self.setup.network_started()
            self.writes.append(value); self.wall = value
        self.setup.setter = setter; self.setup.confirm(ticket, view['utc']); self.assertEqual(len(self.writes), 1)
    def test_elapsed_regression_permanently_refuses(self):
        self.now = 20; ticket, view = self.propose(); self.now = 19
        with self.assertRaises(a.Refusal): self.setup.confirm(ticket, view['utc'])
        self.assertEqual(self.setup.state, 'unknown'); self.assertFalse(self.writes)
    def test_elapsed_callback_error_closes_setup(self):
        def fail(): raise OSError("elapsed unavailable")
        self.setup.elapsed = fail
        with self.assertRaises(OSError): self.propose()
        self.assertEqual(self.setup.state, "unknown")
        with self.assertRaises(a.Refusal): self.propose()
        self.assertFalse(self.writes)
    def test_offline_choice_needs_no_clock_or_network(self):
        self.assertEqual(self.setup.work_offline(), {'terminalAvailable': True, 'networkAuthorized': False, 'clockState': 'unconfirmed'})
        self.assertFalse(self.writes)

if __name__ == '__main__': unittest.main()
