export async function agentScriptExport(retell, agentId) {
  const agent = await retell.agent.retrieve(agentId);
  const engine = agent.response_engine || {};

  let script = null;
  if (engine.conversation_flow_id) {
    script = await retell.conversationFlow.retrieve(engine.conversation_flow_id);
  } else if (engine.llm_id) {
    script = await retell.llm.retrieve(engine.llm_id);
  }

  return {
    takenAt: new Date().toISOString(),
    agent,
    engine: engine.type || null,
    script,
    note: script
      ? null
      : `The agent names a response engine of type ${engine.type || 'unknown'}, which this does ` +
        'not know how to read. The agent itself is above; the questions are not.',
  };
}
