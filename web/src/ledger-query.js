export const DEFAULT_LEDGER_QUERY = { userId: '', status: '', limit: 50, offset: 0 };

export function ledgerQueryReducer(query, change) {
  if (change.type === 'page') return { ...query, offset: Math.max(0, change.offset) };
  if (change.type === 'filter') return { ...query, ...change.values, offset: 0 };
  return query;
}

export function ledgerPage(query, total) {
  const pages = Math.max(1, Math.ceil(total / query.limit));
  return {
    pages,
    page: Math.floor(query.offset / query.limit) + 1,
    lastOffset: (pages - 1) * query.limit,
    hasPrevious: query.offset > 0,
    hasNext: query.offset + query.limit < total,
  };
}

// Only the latest live request can publish data or errors after a filter change.
export function createRequestGate() {
  let generation = 0;
  return {
    begin: () => ++generation,
    invalidate: () => { generation += 1; },
    isCurrent: (request) => request === generation,
  };
}
