import type { Decision, Model, TradeState } from "./model";

export interface PipelinedDecision {
  decision: Decision;
  /** The block whose state produced this decision. */
  block: number;
}

export class DecisionPipeline {
  private latest: PipelinedDecision | null = null;
  private busy = false;

  constructor(private model: Model) {}

  /** Fires a new model request for this block's state, unless one is already in flight. */
  request(block: number, state: TradeState) {
    if (this.busy) return;
    this.busy = true;
    this.model
      .decide(state)
      .then((decision) => {
        this.latest = { decision, block };
      })
      .catch((e) => {
        // Mit Zeitstempel: das Log soll zeigen, WANN Anfragen scheitern (29.10.: die
        // Zeit zwischen 15.10. und 28.10. war nicht mehr rekonstruierbar).
        console.error(`${new Date().toISOString()} decide() for block ${block}:`, (e as Error).message);
      })
      .finally(() => {
        this.busy = false;
      });
  }

  current(): PipelinedDecision | null {
    return this.latest;
  }
}
