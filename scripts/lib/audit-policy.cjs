const PATCHED_ADAPTER = 'https://github.com/advisories/GHSA-rmxm-3fg6-px4f';
function evaluate(report, versions, exceptions, today = new Date().toISOString().slice(0, 10)) {
  if (!report || report.error || report.auditReportVersion !== 2 || !report.vulnerabilities || typeof report.metadata?.vulnerabilities?.total !== 'number')
    throw new Error('Audit response unavailable or invalid');
  if (typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities) ||
      Object.keys(report.vulnerabilities).length !== report.metadata.vulnerabilities.total)
    throw new Error('Audit finding count is inconsistent');
  const findings = report.vulnerabilities;
  const patched = [];
  const memo = new Map();
  function blocked(name, seen = new Set()) {
    if (memo.has(name)) return memo.get(name);
    if (seen.has(name) || !findings[name] || !Array.isArray(findings[name].via) || !findings[name].via.length) return true;
    seen = new Set([...seen, name]);
    const value = findings[name].via.some((via) => {
      if (typeof via === 'string') return blocked(via, seen);
      const exception = exceptions.find((entry) => entry.advisory === via.url && entry.package === name && entry.expires >= today);
      const nodes = findings[name].nodes;
      const fixed = exception && via.url === PATCHED_ADAPTER && name === '@hono/node-server' &&
        Array.isArray(nodes) && nodes.length > 0 && nodes.every((node) => versions[node] === exception.version) && exception.version === '1.19.19';
      if (fixed) patched.push(name);
      return !fixed;
    });
    memo.set(name, value);
    return value;
  }
  return { blocked: Object.keys(findings).filter((name) => blocked(name)), publisherPatched: [...new Set(patched)] };
}
module.exports = { evaluate };
