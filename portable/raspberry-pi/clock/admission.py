"""Offline clock-setup admission prototype, with no OS or network adapter.

All callbacks and bounds are trusted constructor inputs. This object is not an
RPC server or an authorization boundary against code running in its process.
"""
from datetime import datetime, timezone
import math
import re
import threading


class Refusal(ValueError):
    pass


def utc_seconds(value):
    if type(value) is not str or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z', value):
        raise Refusal('Use YYYY-MM-DDTHH:MM:SSZ in UTC')
    try:
        return int(datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc).timestamp())
    except (ValueError, OverflowError) as exc:
        raise Refusal('Invalid UTC calendar date') from exc


class Setup:
    """One correction before network admission; serialized and never retried.

    elapsed must be a nondecreasing suspend-aware clock (CLOCK_BOOTTIME in a
    future Linux adapter). Setter/readback must be bounded trusted operations.
    They are injected here solely to permit tests without setting a clock.
    """
    def __init__(self, *, earliest_utc, latest_utc, elapsed, set_seconds, read_seconds):
        self.low, self.high = utc_seconds(earliest_utc), utc_seconds(latest_utc)
        if self.high <= self.low:
            raise Refusal('Invalid trusted image bounds')
        self.elapsed, self.setter, self.reader = elapsed, set_seconds, read_seconds
        self.state = 'unconfirmed'
        self._ticket = None
        self._last_elapsed = None
        self._lock = threading.RLock()

    def _now(self):
        try:
            now = self.elapsed()
        except BaseException:
            self._ticket = None
            self.state = 'unknown'
            raise
        if type(now) not in (int, float) or not math.isfinite(now) or now < 0 or (self._last_elapsed is not None and now < self._last_elapsed):
            self._ticket = None
            self.state = 'unknown'
            raise Refusal('Elapsed clock unavailable')
        self._last_elapsed = now
        return now

    def propose(self, request):
        with self._lock:
            if self.state not in ('unconfirmed', 'proposed'):
                raise Refusal('Clock setup closed')
            # Failed edits invalidate the earlier confirmation too.
            self._ticket = None
            self.state = 'unconfirmed'
            if type(request) is not dict or set(request) != {'utc'}:
                raise Refusal('Expected only utc')
            seconds = utc_seconds(request['utc'])
            if not self.low <= seconds <= self.high:
                raise Refusal('Outside trusted image date bounds')
            ticket = object()  # In-process reference, not a remotely supplied credential.
            self._ticket = (ticket, request['utc'], seconds, self._now() + 60)
            self.state = 'proposed'
            return ticket, {'utc': request['utc'], 'confirmationSeconds': 60,
                            'accuracy': 'user-provided', 'persistsAfterReboot': False}

    def confirm(self, ticket, displayed_utc):
        with self._lock:
            if self.state != 'proposed' or self._ticket is None:
                raise Refusal('No current confirmation')
            current = self._ticket
            self._ticket = None
            self.state = 'unconfirmed'
            if ticket is not current[0] or type(displayed_utc) is not str or displayed_utc != current[1]:
                raise Refusal('Confirmation changed')
            if self._now() >= current[3]:
                raise Refusal('Confirmation expired; enter current time again')
            # Latch before invoking trusted code; reentrant confirms cannot set twice.
            self.state = 'applying'
            try:
                self.setter(current[2])
                observed = self.reader()
                if type(observed) not in (int, float) or not math.isfinite(observed) or abs(observed - current[2]) > 2:
                    raise Refusal('Clock readback mismatch')
            except BaseException:
                self.state = 'unknown'
                raise
            self.state = 'user-confirmed'
            return {'state': self.state, 'accuracy': 'user-provided',
                    'networkVerified': False, 'persistsAfterReboot': False}

    def network_started(self):
        """Trusted lifecycle hook, never a browser-request field.

        The integration must call this BEFORE allowing any network/financial
        consumer, holding its own start exclusion. No service work occurs here.
        """
        with self._lock:
            if self.state == 'applying':
                raise Refusal('Correction in progress')
            self._ticket = None
            self.state = 'network-locked'

    def work_offline(self):
        # Does not authorize network access or disable future local setup.
        with self._lock:
            if self.state == 'applying':
                raise Refusal('Correction in progress')
            self._ticket = None
            if self.state == 'proposed':
                self.state = 'unconfirmed'
            return {'terminalAvailable': True, 'networkAuthorized': False,
                    'clockState': self.state}
