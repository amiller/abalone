# SPDX-License-Identifier: MIT
"""Byte-mode QR, error correction M, versions 1-6, fixed mask 0, for terminal display."""
# version: (data codewords per block, block count, EC codewords per block, alignment centre)
SPEC={1:(16,1,10,None),2:(28,1,16,18),3:(44,1,26,22),4:(32,2,18,26),5:(43,2,24,30),6:(27,4,16,34)}
def mul(x,y):
 z=0
 for i in reversed(range(8)):z=(z<<1)^((z>>7)*0x11D);z^=((y>>i)&1)*x
 return z
def ec(data,degree):
 divisor=[0]*(degree-1)+[1];root=1
 for _ in range(degree):
  for j in range(degree):
   divisor[j]=mul(divisor[j],root)
   if j+1<degree:divisor[j]^=divisor[j+1]
  root=mul(root,2)
 out=[0]*degree
 for b in data:
  factor=b^out.pop(0);out.append(0)
  for i,c in enumerate(divisor):out[i]^=mul(c,factor)
 return out
def codewords(text):
 raw=text.encode()
 fits=[v for v,(d,n,_,_) in SPEC.items() if len(raw)<=d*n-2]
 if not fits:raise ValueError('QR payload too long')
 version=fits[0]
 d,n,e,_=SPEC[version];bits='0100'+format(len(raw),'08b')+''.join(format(b,'08b') for b in raw)
 bits+='0'*min(4,8*d*n-len(bits));bits+='0'*(-len(bits)%8)
 data=[int(bits[i:i+8],2) for i in range(0,len(bits),8)]
 data+=[(0xEC,0x11)[i%2] for i in range(d*n-len(data))]
 blocks=[data[i*d:(i+1)*d] for i in range(n)];checks=[ec(b,e) for b in blocks]
 return version,[b[i] for i in range(d) for b in blocks]+[c[i] for i in range(e) for c in checks]
def matrix(text):
 version,words=codewords(text);size=17+4*version;m=[[False]*size for _ in range(size)];fixed=[[False]*size for _ in range(size)]
 def put(x,y,dark):m[y][x]=dark;fixed[y][x]=True
 for i in range(size):put(6,i,i%2==0);put(i,6,i%2==0)
 for cx,cy in ((3,3),(size-4,3),(3,size-4)):
  for dy in range(-4,5):
   for dx in range(-4,5):
    if 0<=cx+dx<size and 0<=cy+dy<size:put(cx+dx,cy+dy,max(abs(dx),abs(dy)) not in (2,4))
 a=SPEC[version][3]
 if a:
  for dy in range(-2,3):
   for dx in range(-2,3):put(a+dx,a+dy,max(abs(dx),abs(dy))!=1)
 fmt=0x5412 # level M (00), mask 0: data and BCH remainder are zero, leaving only the XOR mask
 for i in range(6):put(8,i,fmt>>i&1)
 put(8,7,fmt>>6&1);put(8,8,fmt>>7&1);put(7,8,fmt>>8&1)
 for i in range(9,15):put(14-i,8,fmt>>i&1)
 for i in range(8):put(size-1-i,8,fmt>>i&1)
 for i in range(8,15):put(8,size-15+i,fmt>>i&1)
 put(8,size-8,True)
 bits=''.join(format(w,'08b') for w in words);i=0;right=size-1
 while right>=1:
  if right==6:right=5
  for vert in range(size):
   for x in (right,right-1):
    y=size-1-vert if (right+1)&2==0 else vert
    if not fixed[y][x]:
     m[y][x]=i<len(bits) and bits[i]=='1';i+=1
  right-=2
 return [[m[y][x]^(not fixed[y][x] and (x+y)%2==0) for x in range(size)] for y in range(size)]
def terminal(text,quiet=2):
 """Light modules are drawn, so the code reads on a dark terminal background."""
 m=matrix(text);size=len(m)+2*quiet
 light=lambda x,y:not(quiet<=x<size-quiet and quiet<=y<size-quiet and m[y-quiet][x-quiet])
 rows=[]
 for y in range(0,size,2):
  rows.append(''.join(' ▄▀█'[2*light(x,y)+(y+1<size and light(x,y+1))] for x in range(size)))
 return '\n'.join(rows)
