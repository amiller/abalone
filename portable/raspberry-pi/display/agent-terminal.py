#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Dsmack terminal frontend for the fixed local workspace service."""
import argparse, curses, datetime, http.client, json, math, os, re, socket, threading, queue, time, unicodedata, uuid as uuidmod

HOST = "127.0.0.1"
PORT = 8765
ORIGIN = "http://127.0.0.1:8765"
MAX_BODY = 1024 * 1024
MAX_PROMPT = 8192
MAX_LINES = 4000
TERMINAL_STATES = {"done", "aborted", "error", "timeout", "killed", "unavailable"}
UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")


def valid_uuid(u):
    if not isinstance(u, str) or not UUID_RE.fullmatch(u): return False
    try: return str(uuidmod.UUID(u)) == u.lower()
    except ValueError: return False


def safe_text(s, tabsize=8):
    if not isinstance(s, str): return ""
    return "".join(ch for ch in s if ch in "\n\t" or
                   unicodedata.category(ch) not in {"Cc", "Cf", "Cs", "Zl", "Zp"}).expandtabs(tabsize)


class DsmackPublicStatus:
    """Public fields only, with monotonic request-age expiry; never retains CSRF."""
    def __init__(self): self.observe(None,0,0)
    def observe(self,value,started,received):
        self.agent={};self.tor=None;self.credit=None;self.started=0;self.received=0
        self.connected=False;self.backend=False
        if not all(type(x) in (int,float) and math.isfinite(x) and x>=0 for x in (started,received)) or received<started:return
        if not isinstance(value,dict) or value.get('mode')!='service':return
        self.started=started;self.received=received;self.connected=True
        self.backend=not (isinstance(value.get('backend'),dict) and value['backend'].get('available') is False)
        a=value.get('agent')
        if isinstance(a,dict):
            self.agent={k:a.get(k) for k in ('available','kind','state','phase','mode')}
            self.agent['unlock']=a.get('detail')=='Unlock storage to connect the inference provider'
        self.tor=value.get('desktop');self.credit=value.get('credit')
    def _fresh(self,value,cap,now):
        ttl=value.get('validForMs') if isinstance(value,dict) else None
        return type(ttl) is int and 0<ttl<=cap and self.started<=now<self.started+ttl/1000
    def render(self,now):
        result={'tor':'Tor unknown','credit':'Provider account unknown','agent':'Workspace reconnecting','ready':False,'warnings':[]}
        if type(now) not in (int,float) or not math.isfinite(now) or now<self.received or now-self.received>5 or not self.connected:return result
        tor=self.tor.get('tor') if self._fresh(self.tor,15000,now) else None
        tor_ready=False
        if isinstance(tor,dict):
            progress=tor.get('progress');state=tor.get('state')
            if state=='bootstrapped' and type(progress) is int and progress==100:
                result['tor']='Tor 100%';tor_ready=True
            elif state=='starting' and type(progress) is int and 0<=progress<100:result['tor']=f'Connecting to Tor {progress}%'
            elif state=='stopped' and progress is None:result['tor']='Tor stopped'
        c=self.credit
        if self._fresh(c,5000,now) and set(c)=={'state','session','validForMs','accountBalance','allowance','funding'} and c.get('state')=='configured' and valid_uuid(c.get('session')) and c.get('allowance')=={'state':'unknown','reason':'journal-not-bound'} and c.get('funding')=={'state':'not-configured'}:
            a=c.get('accountBalance')
            if isinstance(a,dict) and set(a)=={'provider','scope','currency','amountDecimal','observedAt','providerAsOf','freshness','source'} and a.get('provider') in ('near','ppq') and a.get('scope')=='account' and a.get('currency')=='USD' and a.get('providerAsOf') is None and a.get('source')=='provider-reported':
                amount=a.get('amountDecimal');at=a.get('observedAt');date_ok=False
                if isinstance(at,str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z',at):
                    try:datetime.datetime.strptime(at,'%Y-%m-%dT%H:%M:%S.%fZ');date_ok=True
                    except ValueError:pass
                if isinstance(amount,str) and len(amount)<=64 and re.fullmatch(r'(0|[1-9][0-9]*)(\.[0-9]+)?',amount) and date_ok:
                    if a.get('freshness')=='fresh':result['credit']='Provider account USD '+amount
                    elif a.get('freshness')=='stale':result['credit']='Provider account stale'
        if not self.backend:return result
        a=self.agent;mode=a.get('mode')
        if mode=='broker' and a.get('unlock'):result['agent']='Unlock storage: run ~/unlock'
        elif 'warming' in (a.get('kind'),a.get('state'),a.get('phase')):result['agent']='Agent warming; shell is available'
        elif mode=='broker' and not tor_ready:result['agent']=result['tor']
        elif a.get('available') is True and mode in ('broker','scripted'):
            result['agent']='Inference broker ready' if mode=='broker' else 'Local scripted agent'
            result['ready']=True
        else:result['agent']='Agent not ready; checking automatically'
        return result


class DsmackTranscript:
    """Join deltas in messages and retain only bounded, terminal-safe text."""
    def __init__(self):self.lines=[];self.in_message=False
    def note(self,text):
        self.in_message=False;self.lines.extend(safe_text(text).split('\n'));self._trim()
    def feed(self,event):
        if not isinstance(event,dict):return
        if event.get('type')!='agent_event':
            if event.get('type') in ('error','fatal','unavailable'):self.note('[run reported an error]')
            return
        kind=event.get('event')
        if kind=='message_start' and event.get('role')=='assistant':
            self.lines.append('');self.in_message=True
        elif kind=='message_end':self.in_message=False
        elif kind=='text_delta':
            text=safe_text(event.get('delta',''))
            if not text:return
            if not self.in_message:self.lines.append('');self.in_message=True
            parts=text.split('\n');self.lines[-1]+=parts[0];self.lines.extend(parts[1:])
        elif kind in ('tool_start','tool_end'):
            name=safe_text(event.get('tool','tool'))[:80]
            self.note('['+kind+' '+name+(' failed' if event.get('isError') is True else '')+']')
        self._trim()
    def _trim(self):
        self.lines=self.lines[-1000:]
        left=65536;kept=[]
        for line in reversed(self.lines):
            encoded=line.encode('utf-8');part=encoded[-max(0,left-1):] if left>1 else b''
            kept.append(part.decode('utf-8','ignore'));left-=len(part)+1
            if left<=0:break
        self.lines=list(reversed(kept))
    def snapshot(self):return list(self.lines)


class ApiError(Exception):
    pass


class AgentClient:
    """Fixed HTTP client. Never logs token, raw responses or errors."""
    def __init__(self):
        self.host, self.port = HOST, PORT

    def _request(self, method, path, body=None, token=None, ctype=None):
        conn = http.client.HTTPConnection(self.host, self.port, timeout=3)
        headers = {"Host": "%s:%d" % (self.host, self.port), "Origin": ORIGIN,
                   "Accept": "application/json", "Connection": "close"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            if len(data) > MAX_BODY:
                raise ApiError("too large")
            headers["Content-Length"] = str(len(data))
        if ctype:
            headers["Content-Type"] = ctype
        if token:
            headers["x-workspace-token"] = token
        def expire():
            sock=conn.sock
            if sock is not None:
                try:sock.shutdown(socket.SHUT_RDWR)
                except OSError:pass
        timer=threading.Timer(3,expire);timer.daemon=True;timer.start()
        try:
            conn.request(method, path, body=data, headers=headers)
            resp = conn.getresponse()
            raw = resp.read(MAX_BODY + 1)
        finally:
            timer.cancel();conn.close()
        if len(raw) > MAX_BODY:
            raise ApiError("too large")
        if resp.status != (201 if method == "POST" else 200):
            raise ApiError("http %d" % resp.status)
        if not raw:
            return {}
        try:
            obj = json.loads(raw.decode("utf-8"))
        except Exception:
            raise ApiError("malformed")
        if not isinstance(obj, dict):
            raise ApiError("malformed")
        return obj

    def status(self):
        return self._request("GET", "/api/status")

    def list_agents(self):
        return self._request("GET", "/api/agents")

    def post_agent(self, prompt, token):
        return self._request("POST", "/api/agents", {"prompt": prompt}, token,
                             "application/json")

    def events(self, uid, after, token):
        return self._request("GET", "/api/agents/%s/events?after=%d" % (uid, after),
                             token=token)

    def delete_agent(self, uid, token):
        return self._request("DELETE", "/api/agents/%s" % uid, {}, token,
                             "application/json")


class Controller:
    """One worker owns network state. Side effects are never replayed."""
    def __init__(self, client=None, threaded=True):
        self.client = client or AgentClient()
        self.q = queue.Queue(maxsize=16)
        self.lock = threading.RLock()
        self.transcript = DsmackTranscript(); self.view = DsmackPublicStatus(); self.offset = 0; self.agent_id = None
        self.state = "connecting"; self.token = None; self.available = False
        self.sent_post = False; self.sent_delete = False; self.prompt = ""
        self.status_msg = "connecting"; self.choices = []; self.closed = threading.Event()
        self.worker = None
        if threaded:
            self.worker = threading.Thread(target=self._run, daemon=True)
            self.worker.start()

    def _set(self, **kw):
        with self.lock:
            for k,v in kw.items(): setattr(self,k,v)

    def snapshot(self):
        with self.lock:
            return {"lines":self.transcript.snapshot(), "public":self.view.render(time.monotonic()), "state":self.state,
                    "agent_id":self.agent_id, "status":self.status_msg,
                    "prompt":self.prompt, "choices":list(self.choices)}

    @property
    def lines(self):return self.transcript.snapshot()
    def emit(self,text):
        with self.lock:self.transcript.note(text)

    def command(self,op,arg=None):
        try: self.q.put_nowait((op,arg)); return True
        except queue.Full: return False

    def submit(self,prompt):
        try: valid = bool(prompt.strip()) and len(prompt.encode("utf-8")) <= MAX_PROMPT
        except (AttributeError,UnicodeError): valid = False
        with self.lock:
            if not valid: self.status_msg="invalid prompt"; return False
            if self.sent_post or self.agent_id:
                self.status_msg="not ready; reconcile existing run"; return False
            self.sent_post=True; self.prompt=prompt; self.state="starting"
            if not self.command("post",prompt):
                self.sent_post=False; self.state="idle"; return False
            return True

    def stop(self):
        with self.lock:
            if self.agent_id and not self.sent_delete:
                self.sent_delete=True
                if not self.command("delete",self.agent_id): self.sent_delete=False

    def reconcile(self): self.command("reconcile")
    def select(self,index): self.command("select",index)
    def poll(self): self.command("events")
    def close(self):
        self.closed.set()
        if self.worker: self.worker.join(timeout=4)

    def pump(self,timeout=0):
        try: op,arg=self.q.get(timeout=timeout)
        except queue.Empty: return False
        self._handle(op,arg); return True

    def _run(self):
        self._handle("reconcile",None)
        last_status=0
        while not self.closed.is_set():
            if not self.pump(.15):
                now=time.monotonic()
                if now-last_status>=.5:self._handle("status",None);last_status=time.monotonic()
                if self.agent_id and not self.closed.is_set():self._handle("events",None)

    def _status(self):
        started=time.monotonic();st=self.client.status();received=time.monotonic(); token=st.get("csrfToken")
        if st.get("mode")!="service" or not isinstance(token,str) or not 1<=len(token)<=512:
            raise ApiError("status")
        with self.lock:
            self.view.observe(st,started,received)
            projection=self.view.render(received);ready=projection["ready"]
        self._set(token=token,available=ready)
        if not self.sent_post and not self.agent_id:
            self._set(state="idle",status_msg="ready" if ready else projection["agent"])

    def _attach(self,uid):
        self._set(agent_id=uid,offset=0,state="running",sent_post=True,
                  sent_delete=False,choices=[],status_msg="attached")

    def _handle(self,op,arg):
        try:
            if op=="status": self._status()
            elif op=="post":
                # Once selected, any failed response is ambiguous; never reset this latch.
                try:
                    self._status()
                    if not self.available:
                        self._set(sent_post=False,state="idle",status_msg="not ready; prompt retained")
                        return
                    r=self.client.post_agent(arg,self.token)
                    if not valid_uuid(r.get("id")): raise ApiError("id")
                    self._attach(r["id"])
                except Exception: self._set(state="unknown_start",status_msg="start unknown; Ctrl-R reconcile; no resend")
            elif op=="reconcile":
                self._status(); r=self.client.list_agents(); rows=r.get("agents")
                if not isinstance(rows,list) or len(rows)>256: raise ApiError("agents")
                if any(not isinstance(a,dict) or not valid_uuid(a.get("id")) or type(a.get("alive")) is not bool for a in rows): raise ApiError("agents")
                alive=[a["id"] for a in rows if a["alive"]]
                if len(alive)==1:self._attach(alive[0])
                elif alive:self._set(choices=alive,state="ambiguous",sent_post=True,status_msg="select active run with number")
                elif self.sent_post:self._set(state="unknown_start",status_msg="no active run; start outcome unknown; no resend")
            elif op=="select":
                if type(arg) is int and 0<=arg<len(self.choices):self._attach(self.choices[arg])
            elif op=="events" and self.agent_id:
                uid=self.agent_id; r=self.client.events(uid,self.offset,self.token)
                off=r.get("offset"); events=r.get("events"); state=r.get("state")
                if type(off) is not int or off<self.offset or not isinstance(events,list) or len(events)>10000 or any(not isinstance(e,dict) for e in events) or state not in TERMINAL_STATES|{"starting","running"}:raise ApiError("events")
                if r.get("truncated") is True:self.emit("[event history truncated]")
                for event in events:self._one_event(event)
                self.offset=off
                if state in TERMINAL_STATES:
                    self.emit('[Run '+state+']')
                    self._set(state="terminal-"+state,status_msg="run "+state,agent_id=None,sent_post=False,sent_delete=False)
            elif op=="delete" and self.agent_id==arg:
                try:
                    r=self.client.delete_agent(arg,self.token)
                    if r.get("ok") is not True:raise ApiError("stop")
                    self._set(status_msg="stop confirmed; checking manager state")
                except Exception:self._set(status_msg="stop unknown; no resend")
        except Exception:
            if op in ("status","reconcile"):
                with self.lock:self.view.observe(None,0,0)
            self._set(status_msg="connection or response unavailable; Ctrl-R reconcile")

    def _one_event(self,ev):
        with self.lock:self.transcript.feed(ev)


def clamp_geom(h,w):
    h=max(1,int(h));w=max(1,int(w))
    return max(0,h-7),max(1,w-1),min(7,h)


def layout(lines,h,w):
    rows,cols,_=clamp_geom(h,w)
    out=[]
    for line in lines:
        line=safe_text(line)
        out.extend(line[i:i+cols] for i in range(0,len(line),cols))
    return out[-rows:] if rows else []


def run_ui(ctl,screen,near_warning=False,funding_shortcut=False,shell_home=False):
    edit="";curses.raw();screen.timeout(100);screen.keypad(True)
    try:curses.curs_set(0)
    except curses.error:pass
    try:
        while True:
            h,w=screen.getmaxyx();snap=ctl.snapshot();screen.erase()
            if not edit and (snap['state']=='unknown_start' or snap['status']=='not ready; prompt retained'):
                edit=snap['prompt']
            def put(y,text):
                if 0<=y<h and w>1:
                    try:screen.addnstr(y,0,safe_text(text),w-1)
                    except curses.error:pass
            public=snap["public"]
            put(0,"Dsmack | "+public["tor"]+" | "+public["credit"])
            put(1,public["agent"]+" | "+snap["status"])
            put(2,"NEAR: GPU revocation not checked" if near_warning else "Provider account balance is not a local spend allowance")
            for i,row in enumerate(layout(snap["lines"],h,w)):put(i+3,row)
            choices=" ".join(str(i+1)+":"+uid[:8] for i,uid in enumerate(snap["choices"][:9]))
            put(h-4,"Select active run "+choices if choices else ("Ctrl+Alt+F4 funding | Ctrl+Alt+F2 vault" if funding_shortcut else ""))
            put(h-3,"> "+edit)
            put(h-2,"Enter send | ^X stop | ^R reconnect | ^Q close (run continues)")
            put(h-1,"^Q returns to shell | ~/unlock ~/agent ~/fund ~/credit" if shell_home else "Super+A agent | Super+Enter shell | Super+B browser | Super+F fullscreen")
            screen.refresh()
            try:k=screen.get_wch()
            except curses.error:continue
            if k=="\x11":return
            if k=="\x18":ctl.stop()
            elif k=="\x12":ctl.reconcile()
            elif k in ("\n","\r",curses.KEY_ENTER):
                if ctl.submit(edit):edit=""
            elif k in (curses.KEY_BACKSPACE,"\x7f","\b"):edit=edit[:-1]
            elif snap["choices"] and isinstance(k,str) and k in "123456789":ctl.select(int(k)-1)
            elif isinstance(k,str) and k.isprintable() and len((edit+k).encode())<=MAX_PROMPT:edit+=k
    finally:
        ctl.close()
        curses.noraw()


def main():
    parser=argparse.ArgumentParser(description="Dsmack terminal agent; fixed local workspace service")
    parser.add_argument('--near-warning',action='store_true',help='display installed NEAR demonstration policy warnings')
    parser.add_argument('--funding-shortcut',action='store_true',help='display the installed trusted tty4 funding shortcut')
    parser.add_argument('--shell-home',action='store_true',help='display operator shell commands')
    args=parser.parse_args()
    if os.getuid()!=971:parser.error('run as portable-ui (UID971)')
    curses.wrapper(lambda screen:run_ui(Controller(),screen,args.near_warning,args.funding_shortcut,args.shell_home))

if __name__=="__main__":main()
