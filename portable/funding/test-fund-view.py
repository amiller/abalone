# SPDX-License-Identifier: MIT
import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import fund_view,qr
URI='zcash:t1J9XeAwN8gP2m4uoYFBWBsbmEiwvyjK9gD?amount=0.00172020'
# Independent reference: python-qrcode 7.x, version 4, ERROR_CORRECT_M, mask_pattern=0.
REFERENCE=['1fc562a7f', '1059ba741', '17413415d', '174ba365d', '17550325d', '104e0e741', '1fd55557f', '59ef00', '1542a8312', '69b18b69', '10479401b', 'd220ff00', '2541e9e0', '19b3241e3', '7f7d986b', '1a206da33', 'a4853de8', '1f103d58b', 'cf4c99cf', 'b375ca70', '7410dbdb', 'f0e04581', '105055403', 'fa38e9f1', '107300bf8', '16f891a', '1fc25d15b', '104e0a910', '175d4cdf2', '1740ccc9d', '175a1889d', '1040ebd22', '1fd852143']
def unrender(text,quiet=2):
 rows=[]
 for line in text.split('\n'):
  rows.append([c in '▀█' for c in line]);rows.append([c in '▄█' for c in line])
 size=len(rows[0]);return [[not rows[y][x] for x in range(quiet,size-quiet)] for y in range(quiet,size-quiet)]
class Tests(unittest.TestCase):
 def test_matrix_matches_reference_encoder(self):
  self.assertEqual([format(int(''.join('1' if v else '0' for v in r),2),'x') for r in qr.matrix(URI)],REFERENCE)
 def test_terminal_draws_light_modules_with_quiet_zone(self):
  text=qr.terminal(URI);self.assertEqual(unrender(text),qr.matrix(URI));self.assertTrue(set(text.split('\n')[0])=={'█'})
 def test_version_grows_with_payload_and_refuses_overflow(self):
  self.assertEqual([len(qr.matrix('x'*n)) for n in (14,26,42,62,84,106)],[21,25,29,33,37,41])
  with self.assertRaises(ValueError):qr.matrix('x'*107)
 def test_deposit_shows_qr_address_amount_and_deadline(self):
  text=fund_view.render({'phase':'deposit','depositAddress':'t1J9XeAwN8gP2m4uoYFBWBsbmEiwvyjK9gD','amountZEC':'0.00172020','intendedNEARCreditUSD':'2.00','safeSendBeforeUTC':'2026-10-15T22:53:04.518000+00:00','secondsRemaining':7000,'requiredRemainingSeconds':1055})
  self.assertIn(qr.terminal(URI),text);self.assertIn('send exactly 0.00172020 ZEC',text);self.assertIn('t1J9XeAwN8gP2m4uoYFBWBsbmEiwvyjK9gD',text);self.assertIn('before 22:53 UTC (99 min)',text)
 def test_standing_lines(self):
  text=fund_view.render({'phase':'standing','account':{'remaining':1977000000,'total_spent':23000000},'key':{'limitNanoUSD':20000000,'usageNanoUSD':19000000},'lastFunding':{'creditUSD':'2.00','observedUTC':'2026-10-15T21:26:13+00:00'}})
  self.assertEqual(text,'Account balance: $1.977\nAgent key allowance: $0.001 left ($0.019 used of $0.020 cap)\nLast funding: +$2.00 credited, seen 2026-10-15 21:26')
  self.assertIn('not issued yet',fund_view.render({'phase':'standing','account':{'remaining':0},'key':None,'lastFunding':None}))
 def test_progress_and_outcomes(self):
  self.assertEqual(fund_view.render({'phase':'waiting','swapState':'PROCESSING','acceptNewDeposit':False,'invoicePaid':False}),'Pending funding: swapping ZEC to USDC')
  self.assertIn('quote closed',fund_view.render({'phase':'waiting','swapState':'PENDING_DEPOSIT','acceptNewDeposit':False,'invoicePaid':False}))
  self.assertEqual(fund_view.render({'phase':'funded','creditUSD':'2.00','key':{'limitNanoUSD':3997000000,'usageNanoUSD':20000000}}),'Funded: +$2.00. Agent key allowance: $3.977 left ($0.020 used of $3.997 cap)')
  self.assertIn('Nothing was retried',fund_view.render({'state':'unknown','reason':'operator-refused-or-interrupted'}))
  self.assertEqual(fund_view.render({'state':'novel'}),'{"state": "novel"}')
  self.assertEqual(fund_view.render({'state':'funding-not-set-up'}),'Funding is not set up on this stick: the vault holds no funding wallet. Nothing was quoted or sent.')
  self.assertNotIn('~/fund',fund_view.render({'state':'unknown','reason':'x'}))
if __name__=='__main__':unittest.main()
