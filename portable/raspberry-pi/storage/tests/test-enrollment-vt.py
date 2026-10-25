#!/usr/bin/env python3
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('enrollment_vt',Path(__file__).resolve().parents[1]/'enrollment-vt.py')
vt=importlib.util.module_from_spec(spec);spec.loader.exec_module(vt)

class Console:
    def __init__(self,confirmation=b'CREATE',values=None,lose_after=None):
        self.confirmation=confirmation
        self.values=list(values or [b'correct horse battery',b'correct horse battery',b'synthetic_api_key'])
        self.reads=0;self.checks=0;self.lose_after=lose_after
    def wait_for_active_vt(self,fd,*,expected):
        assert expected == 3
    def require_active_vt(self,fd,*,expected):
        assert expected == 3
        self.checks+=1
        if self.lose_after==self.checks:raise ValueError('inactive console')
    def read_line_echo(self,fd):return self.confirmation
    def read_passphrase_noecho(self,fd):
        self.reads+=1
        return self.values.pop(0)

class Tests(unittest.TestCase):
    def test_eight_byte_acceptance_seven_byte_refusal(self):
        seen=[]
        def transaction(*args):seen.append(1);return {'state':'enrolled-locked'}
        self.assertEqual(vt.setup(Console(values=[b'practice',b'practice',b'synthetic_key']),None,transaction,io.StringIO()),0)
        self.assertEqual(seen,[1])
        short=Console(values=[b'1234567']);seen.clear()
        self.assertEqual(vt.setup(short,None,transaction,io.StringIO()),1)
        self.assertEqual((seen,short.reads),([],1))
    def test_explicit_confirmation_before_any_secret_or_transaction(self):
        for confirmation in (b'',b'create',b'CREATE extra',b'yes'):
            op=Console(confirmation);out=io.StringIO()
            self.assertEqual(vt.setup(op,None,lambda *args:self.fail('transaction'),out),0)
            self.assertEqual(op.reads,0)
    def test_matching_confirmation_and_key_reach_transaction_only_with_active_console(self):
        op=Console();out=io.StringIO();seen=[]
        def transaction(native,*values):
            self.assertIs(native,self)
            self.assertEqual(tuple(bytes(x) for x in values),(b'correct horse battery',b'correct horse battery',b'synthetic_api_key'))
            seen.extend(values)
            return {'state':'enrolled-locked'}
        self.assertEqual(vt.setup(op,self,transaction,out),0)
        self.assertEqual(op.checks,7)
        self.assertTrue(all(not any(value) for value in seen))
        self.assertNotIn('synthetic_api_key',out.getvalue())
        self.assertNotIn('correct horse battery',out.getvalue())
    def test_mismatch_prevents_key_prompt_and_transaction(self):
        op=Console(values=[b'correct horse battery',b'wrong confirmation']);out=io.StringIO()
        self.assertEqual(vt.setup(op,None,lambda *args:self.fail('transaction'),out),1)
        self.assertEqual(op.reads,2)
        self.assertNotIn('Zai API key:',out.getvalue())
    def test_switching_away_from_console_at_each_secret_boundary_prevents_transaction(self):
        for check in range(1,8):
            op=Console(lose_after=check)
            self.assertEqual(vt.setup(op,None,lambda *args:self.fail('transaction'),io.StringIO()),1)
    def test_transaction_failure_is_fixed_and_does_not_echo_secrets_or_retry(self):
        op=Console();out=io.StringIO();calls=[]
        def fail(*args):calls.append(1);raise ValueError('synthetic_api_key')
        self.assertEqual(vt.setup(op,None,fail,out),1)
        self.assertEqual(len(calls),1)
        self.assertNotIn('synthetic_api_key',out.getvalue())
    def test_real_terminal_helpers_are_fixed_to_tty3(self):
        op=vt.tty_helpers()
        self.assertEqual((op.TTY_MAJOR,op.TTY_MINOR,op.EXPECTED_VT),(4,3,3))
    def test_actual_helpers_accept_tty3_and_refuse_tty2_before_secret_intake(self):
        op=vt.tty_helpers()
        with patch.object(op,'vt_active',return_value=3),patch.object(op.termios,'tcflush'),patch.object(op,'read_line_echo',return_value=b''):
            self.assertIsNone(vt.collect(op,io.StringIO()))
        with patch.object(op,'vt_active',side_effect=[3,2]),patch.object(op.termios,'tcflush'),patch.object(op,'read_line_echo',return_value=b'CREATE'),patch.object(op,'read_passphrase_noecho') as read:
            with self.assertRaises(op.OperatorError):vt.collect(op,io.StringIO())
            read.assert_not_called()

if __name__=='__main__':unittest.main()
