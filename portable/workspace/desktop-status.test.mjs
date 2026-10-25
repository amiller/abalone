import test from 'node:test';
import assert from 'node:assert/strict';
import {projectDesktopSnapshot} from './desktop-status.mjs';

const boot = '11111111-1111-4111-8111-111111111111';
const fixture = () => ({version:1,boot_id:boot,observed_boottime:100,tor:{state:'bootstrapped',progress:100},credit:{state:'funded',balance:'999',address:'never-project'}});
const unknown = {state:'unknown',progress:null};

test('projects bootstrap evidence while financial fields stay unknown', () => {
  const value = projectDesktopSnapshot(fixture(),boot,101);
  assert.deepEqual(value,{tor:{state:'bootstrapped',progress:100},credit:{state:'unknown'},validForMs:14000});
  assert.equal(JSON.stringify(value).includes('never-project'),false);
});
test('old boot, stale, future and malformed observation times become unknown', () => {
  for (const mutation of [d=>{d.boot_id='other';},d=>{d.version=true;},d=>{d.observed_boottime=84;},d=>{d.observed_boottime=101;},d=>{d.observed_boottime=NaN;},d=>{d.observed_boottime=Infinity;},d=>{d.observed_boottime=true;}]) {
    const data=fixture();mutation(data);
    assert.deepEqual(projectDesktopSnapshot(data,boot,100).tor,unknown);
  }
});
test('projects only consistent finite Tor states', () => {
  for (const tor of [{state:'starting',progress:0},{state:'starting',progress:99},{state:'stopped',progress:null}]) {
    const data=fixture();data.tor=tor;
    assert.deepEqual(projectDesktopSnapshot(data,boot,100).tor,tor);
  }
  for (const tor of [null,{}, {state:'bootstrapped',progress:99},{state:'starting',progress:100},{state:'starting',progress:1.5},{state:'starting',progress:true},{state:'stopped',progress:100},{state:'other',progress:50},{state:'starting',progress:-1}]) {
    const data=fixture();data.tor=tor;
    assert.deepEqual(projectDesktopSnapshot(data,boot,100).tor,unknown);
  }
});
test('missing or wrong-shaped input cannot disclose arbitrary values', () => {
  for (const value of [null,undefined,[],{},'secret',false,13]) assert.deepEqual(projectDesktopSnapshot(value,boot,100).tor,unknown);
});
