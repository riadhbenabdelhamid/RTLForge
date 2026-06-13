// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// bench/specs — the golden benchmark suite
//
// Ten canonical RTL designs spanning the difficulty range the pipeline is
// meant to handle: combinational + sequential, datapath + control, single-
// clock + clock-domain-crossing, simple + protocol. Each `description` is
// exactly what a user would type into the prompt box — the benchmark drives
// the full pipeline from this NL text (full-auto, no elicitation).
//
// To add a design, append an entry. To run a subset: `node bench/run.mjs
// --spec=fifo_sync,uart_rx`. Keep descriptions concrete and self-contained:
// the benchmark measures the PIPELINE, not the user's prompting skill, so a
// vague spec would just add noise.
// ═══════════════════════════════════════════════════════════════════════════

export const BENCH_SPECS = [
  {
    id: "counter_updown",
    title: "Up/down saturating counter",
    tags: ["sequential", "simple"],
    description:
      "An 8-bit up/down counter with synchronous active-high reset. Inputs: " +
      "clk, rst, en, up (1=count up, 0=count down). Output: count[7:0]. When " +
      "en is high on a rising clock edge, count increments if up else " +
      "decrements. The count saturates at 255 (does not wrap to 0) and at 0 " +
      "(does not wrap to 255). Reset sets count to 0.",
  },
  {
    id: "fifo_sync",
    title: "Synchronous FIFO",
    tags: ["sequential", "memory"],
    description:
      "A synchronous FIFO with a single clock. Parameters: DATA_W (default 8) " +
      "and DEPTH (default 16, a power of two). Ports: clk, rst_n " +
      "(active-low), wr_en, wr_data[DATA_W-1:0], rd_en, rd_data[DATA_W-1:0], " +
      "full, empty. Writes accepted when not full; reads return the oldest " +
      "entry when not empty. full and empty must be correct every cycle and " +
      "no data is lost or duplicated. Simultaneous read+write when neither " +
      "full nor empty is allowed.",
  },
  {
    id: "fifo_async",
    title: "Asynchronous (dual-clock) FIFO",
    tags: ["sequential", "cdc", "hard"],
    description:
      "An asynchronous FIFO crossing two clock domains using Gray-coded " +
      "read/write pointers and two-flop synchronizers. Parameters: DATA_W " +
      "(default 8), ADDR_W (default 4). Ports: wr_clk, wr_rst_n, wr_en, " +
      "wr_data, wr_full; rd_clk, rd_rst_n, rd_en, rd_data, rd_empty. Pointers " +
      "are synchronized across domains with Gray code so no metastable " +
      "multi-bit value is ever sampled. full and empty must be conservative " +
      "(never assert write-when-full or read-when-empty).",
  },
  {
    id: "uart_rx",
    title: "UART receiver",
    tags: ["sequential", "protocol", "fsm"],
    description:
      "A UART receiver, 8 data bits, no parity, 1 stop bit. Parameter " +
      "CLKS_PER_BIT (default 16). Ports: clk, rst_n, rx (serial input), " +
      "data[7:0], data_valid (one-cycle strobe), frame_error. Detect the " +
      "start bit (falling edge of an idle-high line), sample each bit at the " +
      "center of its bit period using CLKS_PER_BIT, deserialize LSB-first, " +
      "and pulse data_valid for one cycle when a byte is complete. Assert " +
      "frame_error if the stop bit is not high.",
  },
  {
    id: "uart_tx",
    title: "UART transmitter",
    tags: ["sequential", "protocol", "fsm"],
    description:
      "A UART transmitter, 8 data bits, no parity, 1 stop bit. Parameter " +
      "CLKS_PER_BIT (default 16). Ports: clk, rst_n, tx_start, tx_data[7:0], " +
      "tx (serial output), tx_busy, tx_done (one-cycle strobe). When tx_start " +
      "pulses and not busy, latch tx_data and shift it out LSB-first framed by " +
      "a low start bit and a high stop bit, each bit held for CLKS_PER_BIT " +
      "cycles. tx is idle-high. Pulse tx_done for one cycle after the stop bit.",
  },
  {
    id: "arbiter_rr",
    title: "Round-robin arbiter",
    tags: ["sequential", "control"],
    description:
      "A 4-requester round-robin arbiter. Ports: clk, rst_n, req[3:0], " +
      "grant[3:0]. At most one grant bit is high per cycle. Grant is given to " +
      "the highest-priority requester, where priority rotates so that after " +
      "granting requester i, requester i+1 (mod 4) has the highest priority " +
      "next. If no requests are asserted, grant is 0. The scheme must be fair: " +
      "no continuously-asserted requester is starved.",
  },
  {
    id: "alu_8bit",
    title: "8-bit ALU",
    tags: ["combinational", "datapath"],
    description:
      "A combinational 8-bit ALU. Ports: a[7:0], b[7:0], op[2:0], " +
      "result[7:0], zero, carry. op selects: 0 ADD, 1 SUB, 2 AND, 3 OR, " +
      "4 XOR, 5 logical shift left a by one, 6 logical shift right a by one, " +
      "7 pass a. carry is the carry-out for ADD and the borrow for SUB (0 for " +
      "logic ops). zero is high when result is 0. Purely combinational; no " +
      "clock.",
  },
  {
    id: "cdc_sync",
    title: "Two-flop CDC synchronizer with pulse",
    tags: ["sequential", "cdc"],
    description:
      "A clock-domain-crossing synchronizer for a single-bit level signal " +
      "plus edge-to-pulse conversion. Ports: dst_clk, dst_rst_n, async_in, " +
      "sync_out, rise_pulse. Sample async_in into the dst_clk domain through " +
      "two flip-flops to remove metastability, drive sync_out from the second " +
      "flop, and assert rise_pulse for exactly one dst_clk cycle on each " +
      "0-to-1 transition of the synchronized signal.",
  },
  {
    id: "spi_master",
    title: "SPI master (mode 0)",
    tags: ["sequential", "protocol", "fsm", "hard"],
    description:
      "An SPI master in mode 0 (CPOL=0, CPHA=0), 8 bits per transfer, " +
      "MSB-first. Parameter CLK_DIV (default 4). Ports: clk, rst_n, start, " +
      "tx_byte[7:0], rx_byte[7:0], busy, done, sclk, mosi, miso. On start " +
      "(when not busy), generate sclk at clk/CLK_DIV, drive mosi on the " +
      "leading edge and sample miso on the trailing edge, for 8 bits. Assert " +
      "busy during the transfer and pulse done for one cycle when the byte " +
      "completes, with rx_byte holding the received data.",
  },
  {
    id: "pwm",
    title: "PWM generator",
    tags: ["sequential", "datapath"],
    description:
      "A pulse-width-modulation generator. Parameter WIDTH (default 8). " +
      "Ports: clk, rst_n, duty[WIDTH-1:0], pwm_out. A free-running counter " +
      "wraps every 2**WIDTH cycles; pwm_out is high while the counter is less " +
      "than duty and low otherwise, giving a duty cycle of duty/2**WIDTH. A " +
      "duty of 0 holds pwm_out low for the whole period; the output updates " +
      "the comparison against duty continuously.",
  },
];

/** Look up specs by comma-separated ids, or return all when filter is empty. */
export function selectSpecs(filter) {
  if (!filter) return BENCH_SPECS.slice();
  const want = new Set(String(filter).split(",").map((s) => s.trim()).filter(Boolean));
  return BENCH_SPECS.filter((s) => want.has(s.id));
}
