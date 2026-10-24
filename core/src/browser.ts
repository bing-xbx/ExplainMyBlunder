// The bundle the page loads as /core.js: the in-page backend for the phone.
export { localApi, importReviews, REVIEW_NODES, coachEvaluator } from './local';
export { runCoachTool } from './coach-tools';
export { parseGameLink, pgnFromLink, looksLikeUrl } from './links';
