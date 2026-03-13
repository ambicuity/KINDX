# Screenshot 05: Vector Search

## Description

Shows a vector similarity search that finds semantically related documents even when the exact query terms do not appear in the results. This demonstrates the power of embedding-based retrieval.

## Command

```bash
$ kindx vsearch my-docs "prevent overfitting in ML models"
```

## Expected Terminal Output

```
$ kindx vsearch my-docs "prevent overfitting in ML models"
Vector Search: "prevent overfitting in ML models" (5 results)

  #1  [0.92] kindx://my-docs/model-training.md
      "Regularization techniques such as dropout, L2 weight decay, and
       early stopping are essential for ensuring the model generalizes
       well to unseen data rather than memorizing training examples..."

  #2  [0.87] kindx://my-docs/evaluation-guide.md
      "Use k-fold cross-validation to detect when your model is fitting
       noise in the training set. A large gap between training and
       validation loss is the clearest signal of poor generalization..."

  #3  [0.83] kindx://my-docs/hyperparameter-tuning.md
      "Learning rate schedules and batch size selection directly impact
       model generalization. A cosine annealing schedule with warm
       restarts often produces more robust convergence..."

  #4  [0.76] kindx://my-docs/data-preprocessing.md
      "Data augmentation artificially expands the training set, helping
       the model learn invariant features rather than spurious
       correlations present in limited data..."

  #5  [0.71] kindx://my-docs/architecture-decisions.md
      "Choosing model capacity appropriate to dataset size is the first
       defense against memorization. Simpler architectures with fewer
       parameters often outperform complex ones on small datasets..."
```

## Annotations

- **Vector scores (0 to 1):** Cosine similarity between the query embedding and document embeddings. 1.0 = identical meaning, 0.0 = completely unrelated.
- **Semantic matching:** Notice that result #1 (`model-training.md`) does not contain the word "overfitting" in the snippet, yet it is the top result because "regularization", "dropout", and "generalizes well" are semantically close to "prevent overfitting".
- **Concept expansion:** The results cover related concepts -- regularization (#1), cross-validation (#2), learning rate tuning (#3), data augmentation (#4), and model capacity (#5) -- all approaches to preventing overfitting, found through meaning rather than keywords.
- **Score distribution:** Vector scores tend to cluster more tightly than BM25 scores. The range 0.92 to 0.71 shows meaningful but gradual relevance decay.
- **Contrast with BM25:** A BM25 search for this query might miss results #3-#5 entirely because they don't contain the term "overfitting". Vector search finds them through semantic similarity.
- **Virtual URIs:** Same `kindx://` URI format as BM25 results, making it easy to reference documents consistently across search modes.
