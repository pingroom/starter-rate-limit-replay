import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportAnalysis } from '../src/engine.js';
import { readJson, atomicJson, acquireLock, atomicText } from '../src/storage.js';
import { validateInput, validateState, tasksFor, parseParameter, rateLimitReplay, analyzeReplay, POLICY, POLICY_HASH, TOKEN, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/model.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-replay-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later parameters; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), '1'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input.max_length = 30; }, (q) => { q.text_input = null; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { q.kind = 'poll'; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-text answers never resolve a count', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), '1'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.analysis, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across parameters', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), '1'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).analysis, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), '1');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), '1'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), '1'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), '1');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), '1'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).analysis, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});
const trace = events => ({traceId:'fixture',title:'Request replay',context:'Offline declared policy fixture.',target:'Test service',events:events.map(([atMs,cost],index)=>({id:`r${index}`,atMs,cost}))});
const answers = (input,values) => tasksFor(input).map((task,index)=>({parameterId:task.id,text:values[index]}));

// Independent millisecond simulation: credit arrives one tick at a time.
// Production jumps directly between arrivals using elapsed-time multiplication.
function tickOracle(input,capacity,rate) {
  let credit=capacity*1000,time=0,totalGenerated=0,totalClipped=0,totalDebited=0;
  const events=[];
  for(const event of input.events){
    const before=credit;let generated=0,clipped=0;
    while(time<event.atMs){time++;generated+=rate;credit+=rate;if(credit>capacity*1000){clipped+=credit-capacity*1000;credit=capacity*1000;}}
    const available=credit,admitted=credit>=event.cost*1000,debit=admitted?event.cost*1000:0;credit-=debit;
    totalGenerated+=generated;totalClipped+=clipped;totalDebited+=debit;
    events.push({before,generated,clipped,available,debit,after:credit,admitted});
  }
  return {events,credit,totalGenerated,totalClipped,totalDebited};
}
function checkAccounting(result){
  const c=result.conservation;assert.equal(BigInt(c.initialCredits)+BigInt(c.generatedCredits),BigInt(c.finalCredits)+BigInt(c.clippedCredits)+BigInt(c.debitedCredits));assert.equal(c.holds,true);
  assert.equal(result.totalAdmitted+result.totalRejected,result.events.length);assert.equal(BigInt(result.requestedCostTokens),BigInt(result.admittedCostTokens)+BigInt(result.rejectedCostTokens));assert.equal(BigInt(result.admittedCostTokens)*1000n,BigInt(c.debitedCredits));
  for(const row of result.events){assert.equal(BigInt(row.generatedCredits),BigInt(row.refilledCredits)+BigInt(row.clippedCredits));assert.equal(BigInt(row.creditsBeforeRefill)+BigInt(row.refilledCredits),BigInt(row.creditsBeforeDecision));assert.equal(BigInt(row.creditsBeforeDecision)-BigInt(row.debitedCredits),BigInt(row.creditsAfterDecision));assert.ok(BigInt(row.creditsAfterDecision)>=0n);assert.ok(BigInt(row.creditsAfterDecision)<=BigInt(result.parameters.capacity)*1000n);}
}

test('independent tick oracle matches all bounded three-event traces, costs, capacities and selected refill rates',()=>{
  let cases=0;
  for(let capacity=1;capacity<=3;capacity++)for(const refill of [0,1,250,500,1000])for(let a=0;a<=4;a++)for(let b=a;b<=4;b++)for(let c=b;c<=4;c++)for(let x=1;x<=4;x++)for(let y=1;y<=4;y++)for(let z=1;z<=4;z++){
    const input=trace([[a,x],[b,y],[c,z]]),actual=analyzeReplay(input,{capacity,refill}),expected=tickOracle(input,capacity,refill);
    assert.deepEqual(actual.events.map(row=>({before:Number(row.creditsBeforeRefill),generated:Number(row.generatedCredits),clipped:Number(row.clippedCredits),available:Number(row.creditsBeforeDecision),debit:Number(row.debitedCredits),after:Number(row.creditsAfterDecision),admitted:row.decision==='admitted'})),expected.events);
    assert.equal(actual.conservation.finalCredits,String(expected.credit));assert.equal(actual.conservation.generatedCredits,String(expected.totalGenerated));assert.equal(actual.conservation.clippedCredits,String(expected.totalClipped));assert.equal(actual.conservation.debitedCredits,String(expected.totalDebited));checkAccounting(actual);cases++;
  }
  assert.equal(cases,33600);
});

test('rejection at 999 ms preserves fractional credit and the next request at 1000 ms is admitted',()=>{
  const result=analyzeReplay(trace([[0,1],[999,1],[1000,1]]),{capacity:1,refill:1});
  assert.deepEqual(result.events.map(row=>row.decision),['admitted','rejected','admitted']);assert.deepEqual(result.events.map(row=>row.creditsBeforeDecision),['1000','999','1000']);
  assert.equal(result.events[1].creditsAfterDecision,'999');assert.equal(result.events[2].elapsedMs,1);assert.equal(result.events[2].generatedCredits,'1');assert.equal(result.events[2].creditsAfterDecision,'0');checkAccounting(result);
});

test('fractional credits accumulate across many rejected events and never round up to a token',()=>{
  const result=analyzeReplay(trace([[0,1],[1,1],[2,1],[3,1],[4,1]]),{capacity:1,refill:333});
  assert.deepEqual(result.events.map(row=>row.creditsBeforeDecision),['1000','333','666','999','1000']);assert.equal(result.events[4].clippedCredits,'332');assert.equal(result.totalAdmitted,2);checkAccounting(result);
});

test('initial idle time and later refill are clipped at capacity and explicitly accounted for',()=>{
  const result=analyzeReplay(trace([[1000,1],[5000,1]]),{capacity:2,refill:3});
  assert.deepEqual(result.events.map(row=>row.generatedCredits),['3000','12000']);assert.deepEqual(result.events.map(row=>row.refilledCredits),['0','1000']);assert.deepEqual(result.events.map(row=>row.clippedCredits),['3000','11000']);
  assert.equal(result.conservation.clippedCredits,'14000');assert.equal(result.conservation.finalCredits,'1000');assert.equal(result.replayedThroughMs,5000);checkAccounting(result);
});

test('zero refill spends only the initial capacity and rejected events never debit',()=>{
  const result=analyzeReplay(trace([[0,2],[0,2],[86400000,1]]),{capacity:3,refill:0});
  assert.deepEqual(result.events.map(row=>row.decision),['admitted','rejected','admitted']);assert.equal(result.events[1].creditsAfterDecision,'1000');assert.equal(result.conservation.generatedCredits,'0');assert.equal(result.totalAdmitted,2);assert.equal(result.admittedCostTokens,'3');checkAccounting(result);
});

test('equal timestamps retain source-array order and costs larger than capacity always reject',()=>{
  const a=trace([[0,2],[0,1]]),b=trace([[0,1],[0,2]]);
  assert.deepEqual(analyzeReplay(a,{capacity:2,refill:1000}).events.map(row=>row.decision),['admitted','rejected']);
  assert.deepEqual(analyzeReplay(b,{capacity:2,refill:1000}).events.map(row=>row.decision),['admitted','rejected']);
  assert.equal(analyzeReplay(a,{capacity:2,refill:0}).admittedCostTokens,'2');assert.equal(analyzeReplay(b,{capacity:2,refill:0}).admittedCostTokens,'1');
  const result=analyzeReplay(trace([[0,3],[86400000,3],[86400000,2]]),{capacity:2,refill:1000});
  assert.deepEqual(result.events.map(row=>row.reason),['cost_exceeds_capacity','cost_exceeds_capacity','enough_credit']);assert.equal(result.events[1].creditsAfterDecision,'2000');checkAccounting(result);
});

test('maximal time, cost, rate and 32-event trace remain exact and bounded',()=>{
  const input=trace(Array.from({length:32},(_,i)=>[i===0?0:86400000,1000])),result=analyzeReplay(input,{capacity:1000,refill:1000});
  assert.equal(result.events.length,32);assert.equal(result.conservation.generatedCredits,'86400000000');assert.equal(result.conservation.clippedCredits,'86399000000');assert.equal(result.totalAdmitted,2);assert.equal(result.totalRejected,30);assert.equal(result.requestedCostTokens,'32000');checkAccounting(result);
});

test('strict schemas reject duplicate or unordered events, unsafe text, extra fields and sparse arrays',()=>{
  for(const mutate of [x=>{x.extra=1;},x=>{x.traceId+='\n';},x=>{x.target='x\u2028y';},x=>{x.title='\ud800';},x=>{x.events=[];},x=>{x.events=Array(33).fill(x.events[0]);},x=>{delete x.events[0];},x=>{x.events[1].id=x.events[0].id;},x=>{x.events[0].id='constructor';},x=>{x.events[0].atMs=-0;},x=>{x.events[0].atMs=-1;},x=>{x.events[0].atMs=86400001;},x=>{x.events[1].atMs=0.5;},x=>{x.events[2].atMs=1;},x=>{x.events[0].cost=0;},x=>{x.events[0].cost=-0;},x=>{x.events[0].cost=1001;},x=>{x.events[0].cost=1.5;},x=>{x.events[0].extra=1;}]){const input=simple();mutate(input);assert.throws(()=>validateInput(input));}
  for(const parameters of [{capacity:0,refill:1},{capacity:1001,refill:1},{capacity:1,refill:-0},{capacity:1,refill:1001},{capacity:1,refill:0.1},{capacity:1,refill:0,extra:1}])assert.throws(()=>analyzeReplay(simple(),parameters));
  const sparse=answers(simple(),['3','2']);delete sparse[0];assert.throws(()=>rateLimitReplay(simple(),sparse));const reordered=answers(simple(),['3','2']).reverse();assert.throws(()=>rateLimitReplay(simple(),reordered));
});

test('parameter grammar distinguishes valid zero refill, unknown and invalid text',()=>{
  assert.deepEqual(parseParameter('refill','0'),{kind:'known',value:0});assert.throws(()=>parseParameter('capacity','0'));assert.deepEqual(parseParameter('capacity','1000'),{kind:'known',value:1000});assert.deepEqual(parseParameter('refill','Unknown'),{kind:'unknown',value:null});
  for(const text of ['','-1','+1','01','1.0','1e2','1001',' 1','1 ','1\n','Unknown\n','unknown','１','1\u200b'])for(const id of ['capacity','refill'])assert.throws(()=>parseParameter(id,text));
  assert.throws(()=>parseParameter('other','1'));
  for(const values of [[null,'2'],['3',null],['Unknown','2'],['3','Unknown']])assert.deepEqual(rateLimitReplay(simple(),answers(simple(),values)),{status:'incomplete',analysis:null});
});

test('maximum parameter prompts preserve target context and declared-model interpretation',()=>{
  const input=trace(Array.from({length:32},(_,i)=>[86400000,1000]));input.traceId='t'.repeat(32);input.title='界'.repeat(32);input.context='é'.repeat(60);input.target='μ'.repeat(60);
  for(const task of tasksFor(input)){const req=requestFor(input,CONFIG,task.id,id(99));assert.ok(req.prompt.length<=500,req.prompt.length);for(const text of [input.context,input.target,'32 events','86400000 ms','full at t=0','not a provider measurement',task.label,task.unit])assert.ok(req.prompt.includes(text));assert.equal(req.options,undefined);assert.equal(req.data.parameter_hash,hash(task));assert.equal(req.data.policy_hash,POLICY_HASH);}
});

test('SDK optional fields remain compatible, while poll results, handoffs, buttons and wrong text configuration fail',async t=>{
  const s=await setup(t);await s.run();delete s.api.questions.get(id(1)).results;delete s.api.questions.get(id(1)).is_handoff;assert.equal((await s.run()).status,'pending');s.api.answer(id(1),'3');assert.equal((await s.run()).status,'ready');
  for(const [field,values] of [['results',[{},[],false,0]],['is_handoff',[true,null,0,'false']]])for(const value of values){const bad=await setup(t);await bad.run();bad.api.questions.get(id(1))[field]=value;await assert.rejects(bad.run(),/does not match/);}
  for(const mutate of [q=>{q.options=[{value:'yes',label:'Yes'}];},q=>{q.text_input.placeholder='Different parameter';}]){const bad=await setup(t);await bad.run();mutate(bad.api.questions.get(id(1)));await assert.rejects(bad.run());}
});

test('complete SDK replay exports attributable private analysis including rejected requests',async t=>{
  const s=await setup(t),result=await decide(s,['3','2']);assert.equal(result.status,'complete');assert.equal(result.analysis.totalAdmitted,3);assert.equal(result.analysis.totalRejected,2);checkAccounting(result.analysis);
  assert.deepEqual(result.answers.map(row=>row.value),[3,2]);assert.ok(result.answers.every(row=>row.responderId===CONFIG.participant.id&&row.askerId===ASKER&&row.parameterHash&&row.answeredAt));
  const calls=s.api.calls.length;assert.deepEqual((await exportAnalysis(s.directory,simple())).analysis,result.analysis);assert.equal(s.api.calls.length,calls);assert.equal(sends(s.api),2);assert.equal((await stat(join(s.directory,'analysis.json'))).mode&0o777,0o600);
  assert.equal(result.declaredModelOnly,true);assert.equal(result.providerMeasured,false);assert.equal(result.traceRequestsSent,false);assert.equal(result.analysis.sourceHash,hash(validateInput(simple())));assert.equal(result.analysis.analysisHash,hash(Object.fromEntries(Object.entries(result.analysis).filter(([key])=>key!=='analysisHash'))));
  const release=await acquireLock(s.directory);await assert.rejects(exportAnalysis(s.directory,simple()),/lock exists/);await release();
});

test('all rejected requests still produce complete exportable analysis, and zero refill remains known',async t=>{
  const input=trace([[0,2],[1000,2]]),s=await setup(t,input),result=await decide(s,['1','0']);assert.equal(result.status,'complete');assert.equal(result.analysis.totalAdmitted,0);assert.equal(result.analysis.totalRejected,2);assert.equal(result.answers[1].value,0);assert.equal((await exportAnalysis(s.directory,input)).analysis.admittedCostTokens,'0');checkAccounting(result.analysis);
});

test('Unknown, capacity zero and invalid refill withhold the entire SDK analysis',async t=>{
  for(const values of [['Unknown','2'],['3','Unknown'],['0','2'],['3','1001']]){const s=await setup(t),result=await decide(s,values);assert.equal(result.status,'incomplete');assert.equal(result.analysis,null);await assert.rejects(exportAnalysis(s.directory,simple()));assert.equal(await readJson(join(s.directory,'analysis.json')),null);}
});

test('trace order, target, costs, source times, policy and saved parameter values stay bound before requests or exports',async t=>{
  const s=await setup(t);await decide(s,['3','2']);const original=await s.saved(),calls=s.api.calls.length;
  for(const mutate of [x=>{x.target='Other policy';},x=>{x.events[0].cost=2;},x=>{x.events[0].atMs=1;},x=>{[x.events[2],x.events[3]]=[x.events[3],x.events[2]];}]){const input=simple();mutate(input);await assert.rejects(s.run({input}));await assert.rejects(exportAnalysis(s.directory,input));}
  for(const mutate of [x=>{x.attempts[0].observation.answer.value=4;},x=>{x.attempts[0].observation.answer.kind='unknown';},x=>{x.attempts[0].request.data.policy_hash=hash({});}]){const saved=structuredClone(original);mutate(saved);await atomicJson(s.directory,'state.json',saved);await assert.rejects(s.run());await assert.rejects(exportAnalysis(s.directory,simple()));}
  await atomicJson(s.directory,'state.json',original);await assert.rejects(s.run({token:'other'}));await assert.rejects(s.run({config:{participant:{id:OTHER,label:'Other'}}}));assert.equal(s.api.calls.length,calls);
});
