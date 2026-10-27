#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Fixed trusted root home commands; no new service or caller-selected target."""
import ctypes, importlib.util, json, os, re, resource, stat, sys, tempfile, time, socket
from pathlib import Path
BASE=Path(__file__).resolve().parent
COMMANDS=('unlock','lock','status','agent','fund','credit','desktop','pseudonym')
def require(value):
    if not value:raise ValueError('Operator command refused')
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def drop(uid,groups):
    term=os.environ.get('TERM','linux')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9+_.-]{0,63}',term):term='linux'
    os.setgroups(groups);os.setgid(uid);os.setuid(uid)
    require(ctypes.CDLL(None).prctl(38,1,0,0,0)==0)
    os.environ.clear();os.environ.update(PATH='/usr/bin:/bin',LANG='C.UTF-8',TERM=term,HOME='/home/portable-ui' if uid==971 else '/')
PI_SOCKET=Path('/run/portable-inference/near.sock')
SESSIONS=Path('/run/portable-vault/agent/sessions')
FILES=Path('/run/portable-vault/agent/files')
SESSION_ARGS={None:['--no-session'],'save':['--session-dir',str(SESSIONS)],'resume':['--session-dir',str(SESSIONS),'--resume']}
SESSION_LINES={None:'Agent session: NOT SAVED. RAM only, gone at exit. (~/agent save keeps it in the vault)',
    'save':f'Agent session: SAVED to the encrypted vault, {SESSIONS}','resume':f'Agent session: SAVED to the encrypted vault; pick a saved session from {SESSIONS}'}
def pi_argv(home,mode=None):
    # RAM-only Pi config; the provider key stays in the financial broker.
    config=home/'agent';config.mkdir(mode=0o700)
    settings=config/'settings.json'
    settings.write_text(json.dumps({'retry':{'enabled':False,'maxRetries':0,'provider':{'maxRetries':0}},'compaction':{'enabled':True},'cacheWarming':'off'}))
    settings.chmod(0o600)
    cli='/opt/portable/vendor/pi/sdk-broker-v4/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
    return ['node',cli,'--offline',*SESSION_ARGS[mode],'--no-extensions','-e',str(BASE.parents[1]/'workspace/pi-broker-extension.mjs'),'--no-mcp','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve','--provider','portable-broker','--model','z-ai/glm-5.3-flash','--thinking','off']
def pi_env(home,term):
    return {'PATH':'/opt/portable/bin:/usr/bin:/bin','LANG':'C.UTF-8','TERM':term,'HOME':str(home),'PI_CODING_AGENT_DIR':str(home/'agent'),'PI_TELEMETRY':'0'}
def launch_pi(mode=None):
    if not PI_SOCKET.is_socket():
        print('Private inference is locked or unavailable. Run ~/unlock first.');return 1
    home=Path(tempfile.mkdtemp(prefix='portable-pi-',dir='/run'))
    argv=pi_argv(home,mode)
    for path in (home/'agent/settings.json',home/'agent',home):os.chown(path,970,970)
    drop(970,[974]);FILES.mkdir(mode=0o700,exist_ok=True);os.chdir(FILES)
    if mode:SESSIONS.mkdir(mode=0o700,exist_ok=True)
    print(f'Agent files: KEPT in the encrypted vault, {FILES} (working directory)',flush=True)
    print(SESSION_LINES[mode],flush=True)
    os.execve('/opt/portable/bin/node',argv,pi_env(home,os.environ['TERM']))
def exchange_home(vault,command,secret=None):
    # Trusted root tty1/SSH entry already admitted the caller before dropping972.
    # The old VT2 UI's focus check is deliberately not this shell's admission.
    require(os.getresuid()==(972,972,972))
    vault.validate_socket()
    request=vault.build_request(command,secret)
    deadline=time.monotonic()+vault.REQUEST_DEADLINE_S
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as channel:
        channel.settimeout(max(.001,deadline-time.monotonic()))
        try:channel.connect(vault.SOCKET_PATH)
        except OSError:return ('error','broker connection refused before send')
        if vault.peer_uid(channel)!=0:return ('error','broker peer refused before send')
        return vault.exchange_on_connected(channel,request,deadline)
def main(args):
    require((len(args)==1 and args[0] in COMMANDS or args in (['fund','--new'],['agent','save'],['agent','resume']) or len(args)==3 and args[:2]==['fund','--amount'] or 2<=len(args)<=3 and args[0]=='pseudonym') and os.getresuid()==(0,0,0))
    command=args[0];resource.setrlimit(resource.RLIMIT_CORE,(0,0));require(ctypes.CDLL(None).prctl(4,0,0,0,0)==0)
    if command=='fund':
        os.execve('/usr/bin/python3',['python3','-I',str(BASE.parents[1]/'funding/operator.py'),'new-demo' if args==['fund','--new'] else 'fund']+args[2:],{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
    if command=='agent':return launch_pi(args[1] if len(args)==2 else None)
    if command=='pseudonym':
        # Root: it starts each pseudonym's Nym client as portable-nym, the one account allowed to reach the mixnet directly.
        os.execve('/opt/portable/bin/node',['node',str(BASE.parents[1]/'pseudonym/pseudonym.mjs'),*args[1:]],{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
    if command=='desktop':os.execv('/usr/bin/systemctl',['systemctl','--no-block','start','portable-display.service'])
    if command=='credit':
        drop(971,[974])
        ui=load('home_agent',BASE/'agent-terminal.py');start=time.monotonic();value=ui.AgentClient().status();end=time.monotonic()
        view=ui.DsmackPublicStatus();view.observe(value,start,end);print(view.render(end)['credit']);return 0
    # Root console/SSH authentication is the operator boundary. Keep the broker's
    # existing UID972 allowlist and root SO_PEERCRED validation unchanged.
    require(all(os.isatty(fd) and stat.S_ISCHR(os.fstat(fd).st_mode) for fd in (0,1,2)))
    vault=load('home_vault',BASE.parent/'storage/operator-vt.py');secret=None
    try:
        drop(972,[973])
        # A second unlock would wait 10 min on the lifecycle lock held by the active credit session.
        if command=='unlock' and exchange_home(vault,'status')[1].startswith('state: unlocked'):print('Vault: already unlocked');return 0
        if command=='unlock':
            print('Vault passphrase: ',end='',flush=True)
            secret=vault.read_passphrase_noecho(0);print()
        state,detail=exchange_home(vault,command,secret)
        print('Vault: '+state+': '+vault.sanitise(detail))
        if state=='unknown':print('Outcome unknown. Run ~/status to reconcile; no automatic retry.')
        return 0 if state=='ok' else 1
    finally:secret=None
if __name__=='__main__':
    try:code=main(sys.argv[1:])
    except BaseException:print('Operator command unavailable; no automatic retry.',file=sys.stderr);code=1
    sys.exit(code)
