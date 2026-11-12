import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {step,exportAnalysis} from './engine.js';
import {readJson} from './storage.js';
import {mockApi,CONFIG,ROOM_CODE} from './mock.js';

const input=await readJson(new URL('../examples/model.json',import.meta.url));
for(const [scenario,responses,admitted,rejected] of [
  ['all-admitted',['10','0'],5,0],
  ['mixed-decisions',['3','2'],3,2],
  ['unknown',['Unknown','2'],null,null],
]){
  const directory=await mkdtemp(join(tmpdir(),'pingroom-replay-demo-'));
  try{
    const now=()=>'2026-11-12T10:00:00.000Z',api=mockApi(now),options={client:api.client,directory,input,config:CONFIG,token:'offline-fixture-token',room:ROOM_CODE,now};let result;
    for(const text of responses){result=await step(options);const pending=result.answers.find(row=>row.status==='pending');api.answer(pending.questionId,text);result=await step(options);}
    assert.equal(result.analysis?.totalAdmitted??null,admitted);assert.equal(result.analysis?.totalRejected??null,rejected);
    if(admitted!==null){assert.equal(result.analysis.conservation.holds,true);await exportAnalysis(directory,input);}else await assert.rejects(exportAnalysis(directory,input));
    assert.equal(api.calls.filter(row=>row.method==='POST').length,2);
    console.log(JSON.stringify({scenario,status:result.status,analysis:result.analysis,mockedQuestions:2,liveDeliveryTested:false},null,2));
  }finally{await rm(directory,{recursive:true,force:true});}
}
