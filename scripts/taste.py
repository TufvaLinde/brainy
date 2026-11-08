"""
Distill the journal into journal/taste.md: a short portrait of what the author finds interesting.
Runs fully local on Apple Silicon. The whole journal (~55k tokens) fits in one prompt, so there is no chunking.

    pip install mlx-lm
    python scripts/taste.py
"""

from pathlib import Path

from mlx_lm import generate, load
from mlx_lm.sample_utils import make_sampler

MODEL = "mlx-community/gemma-4-e4b-it-qat-OptiQ-4bit"
JOURNAL = Path(__file__).resolve().parent.parent / "journal"
OUTPUT = JOURNAL / "taste.md"

INSTRUCTIONS = """Above is my entire journal: notes on ideas I found worth saving, with author and tags in each note's front matter.

Write a lean, tidy markdown file that captures my taste: what I find interesting, which sources I return to, and what makes an idea stick with me. Base every line on the journal; no generic filler.

Use exactly this structure and keep it under 400 words:

# Taste
One short paragraph: the through-line of what I find interesting.

## Themes
5-8 bullets. Each: **theme** - one line on the angle I take on it.

## Sources
The authors I return to most, comma-separated, most frequent first. Only names that appear in the author fields.

## What makes an idea stick
3-5 bullets on the qualities the ideas I save have in common.

## Principles
5-10 short lines, paraphrasing ideas that recur across my notes.

Output only the markdown, not wrapped in a code block."""


def main():
    notes = sorted(p for p in JOURNAL.rglob("*.md") if p != OUTPUT)
    journal = "\n\n".join(p.read_text() for p in notes)

    model, tokenizer = load(MODEL)
    # Instructions go after the journal: small models follow a long-context task best when it comes last.
    messages = [{"role": "user", "content": f"<journal>\n{journal}\n</journal>\n\n{INSTRUCTIONS}"}]
    prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True)
    print(f"{len(notes)} notes")

    # Gemma's recommended sampling; greedy decoding makes small models loop.
    sampler = make_sampler(temp=1.0, top_p=0.95, top_k=64)
    # Smaller prefill steps cap the attention scratch memory for the long prompt; 16 GB Macs swap otherwise.
    taste = generate(model, tokenizer, prompt, max_tokens=3000, sampler=sampler, prefill_step_size=512, verbose=True)
    # Gemma sometimes reasons in a thought channel before answering; keep only the answer after it.
    OUTPUT.write_text(taste.split("<channel|>")[-1].strip() + "\n")
    print(f"wrote {OUTPUT}")


if __name__ == "__main__":
    main()
