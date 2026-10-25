// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ReceiverTemplate} from "./ReceiverTemplate.sol";

/// @title PracticeLedger
/// @notice Public, append-only record of Tidewatch's practice-trading decisions.
///         Each entry is written by a Chainlink CRE workflow (via the Forwarder) and
///         commits to the exact evidence the decision was made on (evidenceHash =
///         keccak256 of the canonical JSON of candles + whale flows + parameters).
///         Anyone can re-run the open-source strategy on that evidence and check the result.
contract PracticeLedger is ReceiverTemplate {
    struct Entry {
        uint64 asOf;          // unix time the evidence refers to (last closed 1h candle)
        uint8 signal;         // 0 WAIT, 1 BUY, 2 AVOID
        uint8 confidence;     // 0..100
        uint64 priceCents;
        uint16 rsiX10;
        uint16 dipBps;
        int64 netFlowUsd;     // stablecoins into minus out of exchange hot wallets
        bytes32 evidenceHash;
        string reasonCode;
        uint64 recordedAt;
    }

    Entry[] private entries;

    event DecisionRecorded(
        uint256 indexed id,
        uint64 indexed asOf,
        uint8 signal,
        uint8 confidence,
        uint64 priceCents,
        bytes32 evidenceHash,
        string reasonCode
    );

    constructor(address forwarder) ReceiverTemplate(forwarder) {}

    function _processReport(bytes calldata report) internal override {
        (
            uint64 asOf,
            uint8 signal,
            uint8 confidence,
            uint64 priceCents,
            uint16 rsiX10,
            uint16 dipBps,
            int64 netFlowUsd,
            bytes32 evidenceHash,
            string memory reasonCode
        ) = abi.decode(report, (uint64, uint8, uint8, uint64, uint16, uint16, int64, bytes32, string));

        entries.push(Entry(asOf, signal, confidence, priceCents, rsiX10, dipBps, netFlowUsd, evidenceHash, reasonCode, uint64(block.timestamp)));
        emit DecisionRecorded(entries.length - 1, asOf, signal, confidence, priceCents, evidenceHash, reasonCode);
    }

    function count() external view returns (uint256) {
        return entries.length;
    }

    function get(uint256 id) external view returns (Entry memory) {
        return entries[id];
    }
}
