function safeRating(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildReport(reviews, classifications, meta) {
  const byId = new Map(classifications.map((item) => [String(item.id), item]));

  const items = reviews.map((review) => {
    const classification = byId.get(String(review.id)) || {
      sentiment: safeRating(review.rating) >= 4 ? "positive" : "negative",
      confidence: 0,
      reason: "Sin clasificacion explicita; se uso la estrella como respaldo."
    };

    return {
      id: review.id,
      author: review.author,
      rating: safeRating(review.rating),
      text: review.text,
      publishedAt: review.publishedAt,
      updatedAt: review.updatedAt,
      source: review.source,
      sourceUrl: review.sourceUrl,
      reply: review.reply,
      sentiment: classification.sentiment === "negative" ? "negative" : "positive",
      confidence: Number(classification.confidence || 0),
      reason: classification.reason || "",
      aiProvider: classification.provider || "",
      aiModel: classification.model || ""
    };
  });

  const totals = items.reduce(
    (acc, item) => {
      acc.total += 1;
      acc[item.sentiment] += 1;
      if (item.rating) {
        acc.ratingCount += 1;
        acc.ratingSum += item.rating;
        acc.byRating[String(Math.round(item.rating))] = (acc.byRating[String(Math.round(item.rating))] || 0) + 1;
      }
      return acc;
    },
    {
      total: 0,
      positive: 0,
      negative: 0,
      ratingCount: 0,
      ratingSum: 0,
      byRating: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    }
  );

  const averageRating = totals.ratingCount ? Number((totals.ratingSum / totals.ratingCount).toFixed(2)) : null;
  const positiveRate = totals.total ? Number(((totals.positive / totals.total) * 100).toFixed(1)) : 0;
  const negativeRate = totals.total ? Number(((totals.negative / totals.total) * 100).toFixed(1)) : 0;

  return {
    meta,
    totals: {
      total: totals.total,
      positive: totals.positive,
      negative: totals.negative,
      positiveRate,
      negativeRate,
      averageRating,
      byRating: totals.byRating
    },
    items
  };
}
