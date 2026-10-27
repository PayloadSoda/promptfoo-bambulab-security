export function extractOutputs(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('需要本次评估的单独 JSON 报告');
  const results = Array.isArray(report.results) ? report.results : report.results?.results;
  if (!Array.isArray(results)) throw new Error('报告中未找到测试结果列表');
  return {
    evalId: typeof report.evalId === 'string' ? report.evalId : null,
    records: results.map((result, index) => {
      const hasResponseOutput = result.response != null && Object.hasOwn(result.response, 'output');
      const hasOutput = hasResponseOutput || Object.hasOwn(result, 'output');
      const output = hasResponseOutput ? result.response.output : result.output;
      const error = result.error ?? result.response?.error ?? null;
      const text = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      return {
        index: index + 1,
        description: result.testCase?.description ?? result.description ?? '',
        provider: typeof result.provider === 'string' ? result.provider : result.provider?.label ?? result.provider?.id ?? '',
        testIndex: Number.isInteger(result.testIdx) ? result.testIdx : null,
        success: typeof result.success === 'boolean' ? result.success : null,
        latencyMs: typeof result.latencyMs === 'number' ? result.latencyMs : null,
        hasOutput,
        output: hasOutput ? text(output) ?? '' : '',
        error: error === null ? null : text(error),
      };
    }),
  };
}
