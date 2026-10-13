"""Train the key CNN on feature caches.

    python -m stoned_mango.cnn.train --synthetic CACHE_DIR [--real CACHE_DIR ...] --out runs/NAME

Uses the GPU when one is available (mixed precision on CUDA). Every epoch it
validates on a held-out slice of each training source, keeps the best
checkpoint (``best.pt``) and appends to ``log.jsonl``.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import torch

from .data import Example, crop, load_cache, split, targets, transpose
from .labels import third_mask
from .model import KeyNet, pooled


def batches(examples: list[Example], batch: int, length: int, max_shift: int, rng: np.random.Generator):
    order = rng.permutation(len(examples))
    for i in range(0, len(order), batch):
        xs, ys = [], []
        for j in order[i:i + batch]:
            ex = examples[j]
            shift = int(rng.integers(-max_shift, max_shift + 1)) if max_shift else 0
            xs.append(transpose(crop(ex.logspec, length, rng).astype(np.float32), shift))
            ys.append(targets(ex, shift))
        yield torch.from_numpy(np.stack(xs))[:, None], torch.tensor(ys)


def loss_fn(logits: torch.Tensor, y: torch.Tensor, thirds: torch.Tensor) -> torch.Tensor:
    """Cross-entropy on the joint (scale, tonic) output; marginal over scales for major/minor-only labels.

    ``y`` rows are (joint, tonic, third); ``thirds`` is the [2, S] mask from labels.third_mask().
    """
    lp = torch.log_softmax(pooled(logits).float(), dim=1)  # [B, S*12]
    joint, tonic, third = y[:, 0], y[:, 1], y[:, 2]
    losses = []
    known = joint >= 0
    if known.any():
        losses.append(-lp[known].gather(1, joint[known, None]).squeeze(1))
    mm = (joint < 0) & (third >= 0)
    if mm.any():
        s = thirds.shape[1]
        by_tonic = lp[mm].reshape(-1, s, 12)  # [n, S, 12]
        at_tonic = by_tonic.gather(2, tonic[mm].view(-1, 1, 1).expand(-1, s, 1)).squeeze(2)  # [n, S]
        masked = at_tonic.masked_fill(~thirds[third[mm]], float("-inf"))
        losses.append(-torch.logsumexp(masked, dim=1))
    return torch.cat(losses).mean() if losses else lp.new_zeros(())


@torch.no_grad()
def evaluate(model: KeyNet, examples: list[Example], device: torch.device) -> dict:
    """Full-length inference, one song at a time.

    key24: tonic and third right (the classic 24-key task); tonic: tonic right;
    mode: tonic and scale both right (only where the scale is labelled).
    """
    model.eval()
    majors = third_mask(model.config["max_tier"])[0]
    hits = {"key24": [], "tonic": [], "mode": []}
    for ex in examples:
        x = torch.from_numpy(ex.logspec.astype(np.float32))[None, None].to(device)
        best = int(pooled(model(x))[0].argmax())
        scale, tonic = divmod(best, 12)
        third = "major" if majors[scale] else "minor"
        if ex.tonic >= 0:
            hits["tonic"].append(tonic == ex.tonic)
            if ex.third:
                hits["key24"].append(tonic == ex.tonic and third == ex.third)
        if ex.scale >= 0:
            hits["mode"].append((tonic, scale) == (ex.tonic, ex.scale))
    return {k: (round(float(np.mean(v)), 4) if v else None) for k, v in hits.items()} | {"n": len(examples)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--synthetic", type=Path, nargs="*", default=[], help="songgen --features caches")
    ap.add_argument("--real", type=Path, nargs="*", default=[], help="cnn.data caches of real music")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--length", type=int, default=256, help="training crop in frames (~24 s)")
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--width", type=int, default=16)
    ap.add_argument("--dense", type=int, default=64)
    ap.add_argument("--max-shift", type=int, default=6, help="random transposition range in semitones")
    ap.add_argument("--real-weight", type=int, default=3, help="repeat real examples this many times per epoch")
    ap.add_argument("--val-fraction", type=float, default=0.1)
    ap.add_argument("--patience", type=int, default=8)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    device = torch.device(args.device)
    args.out.mkdir(parents=True, exist_ok=True)

    train, val = [], {}
    for root, kind in [(r, "synthetic") for r in args.synthetic] + [(r, "real") for r in args.real]:
        ex = load_cache(root)
        tr, va = split(ex, args.val_fraction, args.seed)
        train += tr * (args.real_weight if kind == "real" else 1)
        val[f"{kind}:{root.name}"] = va
        print(f"{kind} {root}: {len(tr)} train, {len(va)} val")
    if not train:
        raise SystemExit("no training data: pass --synthetic and/or --real cache directories")

    model = KeyNet(width=args.width, dense=args.dense).to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"KeyNet {model.config}: {n_params:,} parameters on {device}")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    steps_per_epoch = math.ceil(len(train) / args.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.epochs * steps_per_epoch)
    thirds = torch.from_numpy(third_mask(model.config["max_tier"])).to(device)
    use_amp = device.type == "cuda"
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)

    best, best_epoch, log = -1.0, -1, args.out / "log.jsonl"
    log.write_text("")
    for epoch in range(1, args.epochs + 1):
        model.train()
        t0, total, n = time.time(), 0.0, 0
        for x, y in batches(train, args.batch, args.length, args.max_shift, rng):
            x, y = x.to(device, non_blocking=True), y.to(device)
            with torch.autocast(device.type, enabled=use_amp):
                loss = loss_fn(model(x), y, thirds)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            sched.step()
            total += float(loss.detach()) * len(x)
            n += len(x)
        metrics = {name: evaluate(model, ex, device) for name, ex in val.items()}
        # Model selection: mean of every available validation accuracy (key24 and exact mode).
        scores = [m[k] for m in metrics.values() for k in ("key24", "mode") if m.get(k) is not None]
        score = float(np.mean(scores)) if scores else -float(total / max(n, 1))
        entry = {"epoch": epoch, "loss": round(total / max(n, 1), 4), "score": round(score, 4),
                 "seconds": round(time.time() - t0, 1), "val": metrics}
        with log.open("a") as f:
            f.write(json.dumps(entry) + "\n")
        print(json.dumps(entry))
        if score > best:
            best, best_epoch = score, epoch
            torch.save({"state_dict": model.state_dict(), "config": model.config, "epoch": epoch,
                        "val": metrics, "args": {k: str(v).replace(str(Path.home()), "~") for k, v in vars(args).items()}},
                       args.out / "best.pt")
        elif epoch - best_epoch >= args.patience:
            print(f"no improvement for {args.patience} epochs, stopping")
            break
    print(f"best epoch {best_epoch}, score {best:.4f} -> {args.out / 'best.pt'}")


if __name__ == "__main__":
    main()
