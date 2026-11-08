// Vercel serverless entry point: every /api/* request (see vercel.json rewrites) is handled by the
// Node prototype's request handler. Storage is MongoDB (MONGODB_URI) and the model is a hosted API
// (GROQ_API_KEY), both set as Vercel environment variables.
module.exports = async (req, res) => {
  const { handler } = require('../alt/node-prototype/server.js');
  return handler(req, res);
};
