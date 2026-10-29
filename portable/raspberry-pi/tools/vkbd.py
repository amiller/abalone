# Virtual US keyboard on the Pi: stdin lines "type TEXT", "key COMBO" (e.g. meta+shift+e, ctrl+d, enter), "sleep SECONDS".
# usage (root on the Pi): python3 -I -u vkbd.py < commands
import fcntl,os,struct,sys,time,random
K=dict(zip('1234567890',range(2,12)));K.update(zip('qwertyuiop',range(16,26)));K.update(zip('asdfghjkl',range(30,39)));K.update(zip('zxcvbnm',range(44,51)))
K.update({'-':12,'=':13,'[':26,']':27,';':39,"'":40,'`':41,'\\':43,',':51,'.':52,'/':53,' ':57,'\n':28})
S=dict(zip('!@#$%^&*()_+{}:"~|<>?',[2,3,4,5,6,7,8,9,10,11,12,13,26,27,39,40,41,43,51,52,53]))
N={'esc':1,'backspace':14,'tab':15,'enter':28,'ctrl':29,'shift':42,'alt':56,'meta':125,'space':57,'up':103,'down':108,'left':105,'right':106}
fd=os.open('/dev/uinput',os.O_WRONLY|os.O_NONBLOCK);fcntl.ioctl(fd,0x40045564,1)
for c in set(K.values())|set(S.values())|set(N.values()):fcntl.ioctl(fd,0x40045565,c)
os.write(fd,struct.pack('80sHHHHi',b'dsmack-demo-keyboard',3,1,4,1,0)+b'\0'*(64*4*4));fcntl.ioctl(fd,0x5501);time.sleep(1.5)
def ev(c,v):os.write(fd,struct.pack('llHHi',0,0,1,c,v)+struct.pack('llHHi',0,0,0,0,0))
def press(codes):
 for c in codes:ev(c,1);time.sleep(0.02)
 time.sleep(0.05)
 for c in reversed(codes):ev(c,0);time.sleep(0.02)
for line in sys.stdin:
 cmd,_,arg=line.rstrip('\n').partition(' ')
 if cmd=='type':
  for ch in arg:
   if ch.isupper():press([42,K[ch.lower()]])
   elif ch in S:press([42,S[ch]])
   else:press([K[ch]])
   time.sleep(random.uniform(0.04,0.13))
 elif cmd=='key':press([N.get(k) or K[k] for k in arg.split('+')])
 elif cmd=='sleep':time.sleep(float(arg))
 print('ok',cmd,flush=True)
time.sleep(0.5);fcntl.ioctl(fd,0x5502);os.close(fd)
