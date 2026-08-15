import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(`${os.tmpdir()}/z-agent-store-`);
process.env.Z_AGENT_DATA_DIR = path.join(data, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(data, 'workspaces');
const store = await import('../server/native/store.mjs');

test('native store owns users, chats, messages, questions, permissions and provider state', () => {
  store.createUser('a@example.com', 'hash', 'admin');
  const chat = store.createChat('ses_test1', 'a@example.com', 'Test');
  assert.equal(chat.title, 'Test');
  assert.equal(store.ownsChat('ses_test1', 'a@example.com'), true);
  assert.equal(store.ownsChat('ses_test1', 'b@example.com'), false);
  store.putMessage({ id:'msg_1', sessionID:'ses_test1', role:'user', parts:[{type:'text',text:'hi'}], time:{created:1,completed:1}, info:{} });
  assert.equal(store.listMessages('ses_test1')[0].parts[0].text, 'hi');
  store.createQuestion('que_1','ses_test1',[{question:'Pick'}]);
  assert.equal(store.listPendingQuestions('ses_test1').length,1);
  store.resolveQuestion('que_1',[['A']]);
  assert.equal(store.listPendingQuestions('ses_test1').length,0);
  store.createPermission('per_1','ses_test1','bash',{command:'true'});
  store.resolvePermission('per_1','once');
  assert.equal(store.getPermission('per_1').response,'once');
  store.setProviderKey('a@example.com','openai','secret');
  assert.equal(store.getProviderKey('a@example.com','openai'),'secret');
  store.upsertManualModel('a@example.com','openai',{modelId:'custom-x',name:'X',isFree:true,enabled:true});
  assert.equal(store.listManualModels('a@example.com','openai')[0].model_id,'custom-x');
  store.setHiddenModel('a@example.com','openai','custom-x',true);
  assert.deepEqual(store.listHiddenModels('a@example.com','openai'),['custom-x']);
});

test('runtime restart recovery fails orphaned turns/actions and closes pending gates', () => {
  store.setTurn('ses_test1', { turnId:'turn_restart', lifecycle:'waiting_user_input', since:Date.now() });
  store.createQuestion('que_restart','ses_test1',[{question:'Pending'}]);
  store.createPermission('per_restart','ses_test1','bash',{command:'true'});
  assert.equal(store.claimAction('ses_test1','act_restart'), true);
  assert.equal(store.recoverInterruptedRuntimeState(), 1);
  assert.equal(store.getTurn('ses_test1').lifecycle, 'failed');
  assert.equal(store.getTurn('ses_test1').reason, 'runtime_restart');
  assert.equal(store.getAction('ses_test1','act_restart').state, 'failed');
  assert.equal(store.listPendingQuestions('ses_test1').length, 0);
  assert.equal(store.getPermission('per_restart').status, 'rejected');
});

test('action ledger is idempotent and queue is persisted', () => {
  assert.equal(store.claimAction('ses_test1','act_1'), true);
  assert.equal(store.claimAction('ses_test1','act_1'), false);
  store.completeAction('ses_test1','act_1',{ok:true});
  assert.deepEqual(store.getAction('ses_test1','act_1').result,{ok:true});
  assert.equal(store.enqueueAction('ses_test1','act_2',{text:'next'}), 'queued');
  assert.equal(store.enqueueAction('ses_test1','act_2',{text:'next'}), 'duplicate');
  assert.equal(store.listQueue('ses_test1').length,1);
  assert.equal(store.dequeueAction('ses_test1','act_2'),true);
});

test.after(() => { store.closeStore(); fs.rmSync(data,{recursive:true,force:true}); });
