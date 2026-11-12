import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const POLICY = Object.freeze({ algorithm:'strict-single-token-bucket-v1', initial:'full-at-zero-v1', time:'ordered-millisecond-offsets-v1', creditScale:1000, rejection:'no-debit-no-queue-v1', unknown:'both-parameters-required-v1' });
export const POLICY_HASH = hash(POLICY);
const safeId = value => word(value) && value.length <= 12 && !['constructor','prototype','__proto__'].includes(value);
const integer = (value,min,max) => Number.isSafeInteger(value) && value >= min && value <= max && !Object.is(value,-0);
const PARAMETERS = [
  {id:'capacity',label:'burst capacity',unit:'tokens',minimum:1,maximum:1000},
  {id:'refill',label:'refill rate',unit:'tokens per second',minimum:0,maximum:1000},
];
const promptFor = (input,task) => `${input.title}\nTrace ${input.traceId}: ${input.context}\nTarget: ${input.target}\nReplay: ${input.events.length} events through ${input.events.at(-1).atMs} ms. Strict single bucket, full at t=0; rejected costs do not debit; no queue.\nDeclare ${task.label} in ${task.unit}: integer ${task.minimum}..${task.maximum}, or exactly Unknown if not established. This is a declared model, not a provider measurement.`;
export function validateInput(input) {
  if (!keys(input,['traceId','title','context','target','events']) || !word(input.traceId) || input.traceId.length > 32
    || !line(input.title,32) || !line(input.context,60) || !line(input.target,60) || !Array.isArray(input.events) || input.events.length < 1 || input.events.length > 32) throw new Error('Provide trace context, target and 1–32 ordered events.');
  const ids = new Set(); let previous = 0;
  for (const event of input.events) {
    if (!keys(event,['id','atMs','cost']) || !safeId(event.id) || ids.has(event.id) || !integer(event.atMs,0,86400000) || event.atMs < previous || !integer(event.cost,1,1000)) throw new Error('Events require unique safe IDs, nondecreasing integer atMs 0..86400000 and integer cost 1..1000.');
    ids.add(event.id); previous = event.atMs;
  }
  const result = structuredClone(input);
  if (PARAMETERS.some(task => promptFor(result,task).length > 500)) throw new Error('Full policy parameter prompt exceeds 500 characters.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config,['participant']) || !keys(config.participant,['id','label']) || !isId(config.participant.id) || !line(config.participant.label,60)) throw new Error('Config requires an exact policy owner UUID and label.');
  return structuredClone(config);
}
export function tasksFor(input) { validateInput(input); return structuredClone(PARAMETERS); }
export function parseParameter(parameterId,text) {
  const task = PARAMETERS.find(row => row.id === parameterId);
  if (!task) throw new Error('Unknown policy parameter.');
  if (text === 'Unknown') return {kind:'unknown',value:null};
  if (typeof text !== 'string' || !/^(?:0|[1-9][0-9]{0,3})(?![\s\S])/.test(text) || !integer(Number(text),task.minimum,task.maximum)) throw new Error(`Reply an integer ${task.minimum}..${task.maximum} or exactly Unknown.`);
  return {kind:'known',value:Number(text)};
}
export function requestFor(rawInput,config,taskId,attemptId) {
  const input = validateInput(rawInput), task = PARAMETERS.find(row => row.id === taskId); validateConfig(config);
  if (!task || !isId(attemptId)) throw new Error('Invalid policy parameter or attempt.');
  const key = `replay-${attemptId}`;
  return {prompt:promptFor(input,task),context:`To ${config.participant.id}`,text_input:{placeholder:`${task.minimum}..${task.maximum} or Unknown`,max_length:60},
    responder_scope:'direct',target_user_id:config.participant.id,ttl:TTL,correlation_id:key,
    data:{input_hash:hash(input),parameter_hash:hash(task),policy_hash:POLICY_HASH,task_id:taskId,attempt_id:attemptId},idempotencyKey:key};
}

export function analyzeReplay(rawInput,parameters) {
  const input = validateInput(rawInput);
  if (!keys(parameters,['capacity','refill']) || !integer(parameters.capacity,1,1000) || !integer(parameters.refill,0,1000)) throw new Error('Known capacity 1..1000 and refill 0..1000 are required.');
  const capacityCredits = BigInt(parameters.capacity) * 1000n, rate = BigInt(parameters.refill);
  let credits = capacityCredits, previous = 0, generatedTotal = 0n, clippedTotal = 0n, debitedTotal = 0n, admittedCost = 0n, rejectedCost = 0n;
  const events = input.events.map((event,index) => {
    const elapsedMs = event.atMs - previous, beforeRefill = credits, generated = BigInt(elapsedMs) * rate;
    const room = capacityCredits - credits, refilled = generated < room ? generated : room, clipped = generated - refilled;
    credits += refilled; const beforeDecision = credits, costCredits = BigInt(event.cost) * 1000n, admitted = costCredits <= credits;
    const debited = admitted ? costCredits : 0n; credits -= debited;
    generatedTotal += generated; clippedTotal += clipped; debitedTotal += debited;
    if (admitted) admittedCost += BigInt(event.cost); else rejectedCost += BigInt(event.cost);
    previous = event.atMs;
    return {...event,sourceIndex:index,elapsedMs,creditsBeforeRefill:beforeRefill.toString(),generatedCredits:generated.toString(),refilledCredits:refilled.toString(),clippedCredits:clipped.toString(),creditsBeforeDecision:beforeDecision.toString(),costCredits:costCredits.toString(),
      decision:admitted?'admitted':'rejected',reason:admitted?'enough_credit':event.cost>parameters.capacity?'cost_exceeds_capacity':'insufficient_credit',debitedCredits:debited.toString(),creditsAfterDecision:credits.toString()};
  });
  const requestedCost = input.events.reduce((sum,event) => sum + BigInt(event.cost),0n);
  if (capacityCredits+generatedTotal !== credits+clippedTotal+debitedTotal || requestedCost !== admittedCost+rejectedCost) throw new Error('Internal replay conservation failure.');
  const totalAdmitted = events.filter(row => row.decision === 'admitted').length;
  const result = {status:'replayed',parameters:structuredClone(parameters),creditScale:1000,initialAtMs:0,replayedThroughMs:previous,events,totalAdmitted,totalRejected:events.length-totalAdmitted,
    requestedCostTokens:requestedCost.toString(),admittedCostTokens:admittedCost.toString(),rejectedCostTokens:rejectedCost.toString(),
    conservation:{initialCredits:capacityCredits.toString(),generatedCredits:generatedTotal.toString(),clippedCredits:clippedTotal.toString(),debitedCredits:debitedTotal.toString(),finalCredits:credits.toString(),
      holds:capacityCredits+generatedTotal === credits+clippedTotal+debitedTotal},sourceHash:hash(input),declaredModelOnly:true,providerMeasured:false,traceRequestsSent:false,queuedRequests:0,retriesScheduled:0};
  return {...result,analysisHash:hash(result)};
}
export function rateLimitReplay(rawInput,answers) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!Array.isArray(answers) || answers.length !== tasks.length || Array.from(answers).some((row,index) => !keys(row,['parameterId','text']) || row.parameterId !== tasks[index].id || row.text !== null && typeof row.text !== 'string')) throw new Error('Provide one ordered text answer or missing outcome for each policy parameter.');
  const outcomes = answers.map(row => row.text === null ? {kind:'missing',value:null} : parseParameter(row.parameterId,row.text));
  if (outcomes.some(row => row.kind !== 'known')) return {status:'incomplete',analysis:null};
  return {status:'complete',analysis:analyzeReplay(input,Object.fromEntries(tasks.map((task,index) => [task.id,outcomes[index].value])))};
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || state.credentialHash.length !== 64 || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) {
    throw new Error('Invalid state or changed request trace. Restore the original inputs.');
  }
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set();
  let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.taskId !== tasks[index].id
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
      throw new Error('Invalid saved parameter request.');
    }
    ids.add(attempt.id);
    previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) {
      throw new Error('Only the last task may have an active Question.');
    }
  }
  return state;
}

export function report(state,rawInput) {
  const input = validateInput(rawInput); validateState(state,input);
  const answers = tasksFor(input).map(task => {
    const attempt = state.attempts.find(row => row.taskId === task.id), answer = attempt?.observation?.answer;
    return {parameterId:task.id,parameterHash:hash(task),status:attempt?.status === 'creating'?'create_unknown':attempt?.status??'unasked',text:answer?.text??null,kind:answer?.kind??null,value:answer?.value??null,
      questionId:attempt?.questionId??null,attemptId:attempt?.id??null,responderId:answer?.responderId??null,answeredAt:answer?.answeredAt??null,askerId:attempt?.observation?.askerId??null,observedAt:attempt?.observation?.checkedAt??null};
  });
  const calculation = rateLimitReplay(input,answers.map(({parameterId,text}) => ({parameterId,text}))), active = answers.find(row => ['create_unknown','pending'].includes(row.status));
  const status = active?.status??(answers.some(row => row.status === 'unasked')?'ready':calculation.status);
  return {traceId:input.traceId,source:input,sourceHash:hash(input),configHash:hash(state.config),policy:POLICY,policyHash:POLICY_HASH,participant:state.config.participant,room:state.room,answers,analysis:calculation.analysis,status,
    declaredModelOnly:true,providerMeasured:false,traceRequestsSent:false};
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['text', 'kind', 'value', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || hash(parseParameter(request.data.task_id,answer.text)) !== hash({kind:answer.kind,value:answer.value})
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved parameter evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain parameter evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== undefined && q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== undefined && q.results !== null || hash(q.text_input) !== hash(request.text_input) || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 0) throw new Error('Question does not match the saved task, room, or policy owner.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.value !== null || answer.label !== null || answer.responder?.id !== request.target_user_id || typeof answer.text !== 'string' || answer.text.length > 60) throw new Error('Invalid text answer.');
      observation.answer = { text:answer.text,...parseParameter(request.data.task_id,answer.text),responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
