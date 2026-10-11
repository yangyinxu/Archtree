interface DecisionTestAnswer {
  type: string;
  name: string;
  choice?: string;
  confidence?: number;
  probabilities?: Array<{value: string; probability: number}>;
  probability?: number;
}

/** Provider-shaped test answers for both direct and private-proxy screening. */
export const decisionsResponse = (ids: string[], options: {
  decision?: 'analyze' | 'uncertain' | 'skip';
  confidence?: number;
  informationType?: string;
} = {}) => {
  const decision = options.decision ?? 'analyze';
  const confidence = options.confidence ?? 0.99;
  const information = options.informationType ?? 'product_feedback';
  const choice = (name: string, selected: string, values: string[]) => ({
    type: 'choice', name, choice: selected, confidence,
    probabilities: values.map((value) => ({value,
      probability: value === selected ? confidence : (1 - confidence) / (values.length - 1)
    }))
  });
  return {
    model: 'gpt-6-luna',
    answers: ids.flatMap<DecisionTestAnswer>((id) => [
      choice(`${id}:decision`, decision, ['analyze', 'uncertain', 'skip']),
      {type: 'predicate', name: `${id}:relevant`, probability: 0.99},
      choice(`${id}:information`, information, [
        'product_feedback', 'gameplay_advice', 'factual_info', 'community_chatter',
        'lore_discussion', 'content_request'
      ])
    ]),
    usage: {input_tokens: 1000, input_tokens_details: {cached_tokens: 200},
      output_tokens: 0, output_tokens_details: {reasoning_tokens: 0}, total_tokens: 1000}
  };
};
