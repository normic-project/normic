// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

/// @notice Non-upgradeable, USDG-only service escrow. Not externally audited.
contract NormicServiceEscrow is ReentrancyGuard, Pausable, AccessControlDefaultAdminRules {
    using SafeERC20 for IERC20;
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 public constant CHAIN_ID = 4663;
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
    uint256 public immutable maxPayment;
    uint8 public immutable tokenDecimals;
    uint256 public totalObligations;

    enum State { UNFUNDED, FUNDED, ACCEPTED, SUBMITTED, DISPUTED, RELEASED, REFUNDED }
    struct Terms {
        bytes32 nonce;
        address buyer;
        address provider;
        address providerOwner;
        uint256 amount;
        uint64 acceptBy;
        uint64 completeBy;
        uint64 reviewPeriod;
    }
    struct Invocation {
        Terms terms;
        State state;
        bytes32 resultHash;
        uint64 reviewBy;
    }
    struct SpendingPolicy {
        bool enabled;
        uint64 expiresAt;
        uint256 perTransaction;
        uint256 perDay;
    }
    mapping(bytes32 => Invocation) private invocations;
    mapping(address => SpendingPolicy) public spendingPolicies;
    mapping(address => mapping(uint256 => uint256)) public dailySpend;

    event InvocationFunded(bytes32 indexed invocationId, address indexed buyer, address indexed provider, uint256 amount);
    event InvocationAccepted(bytes32 indexed invocationId);
    event ResultSubmitted(bytes32 indexed invocationId, bytes32 resultHash, uint64 reviewBy);
    event InvocationReleased(bytes32 indexed invocationId, address indexed provider, uint256 amount);
    event InvocationRefunded(bytes32 indexed invocationId, address indexed buyer, uint256 amount);
    event DisputeOpened(bytes32 indexed invocationId);
    event DisputeResolved(bytes32 indexed invocationId, bool released);
    event SpendingPolicyUpdated(address indexed wallet, bool enabled, uint64 expiresAt, uint256 perTransaction, uint256 perDay);
    error InvalidConfiguration();
    error WrongChain();
    error InvalidState();
    error Unauthorized();
    error InvalidTerms();
    error Deadline();
    error InexactTransfer();
    error SpendingDenied();

    constructor(address admin, address resolver, uint48 adminDelay, uint256 maximum)
        AccessControlDefaultAdminRules(adminDelay, admin)
    {
        if (block.chainid != CHAIN_ID) revert WrongChain();
        if (admin == address(0) || resolver == address(0) || maximum == 0 || USDG.code.length == 0) revert InvalidConfiguration();
        uint8 decimals = IERC20Metadata(USDG).decimals();
        if (decimals > 36 || keccak256(bytes(IERC20Metadata(USDG).symbol())) != keccak256("USDG")) revert InvalidConfiguration();
        IERC20(USDG).totalSupply();
        tokenDecimals = decimals;
        maxPayment = maximum;
        _grantRole(RESOLVER_ROLE, resolver);
    }
    modifier onMainnet() { if (block.chainid != CHAIN_ID) revert WrongChain(); _; }
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
    function getInvocation(bytes32 id) external view returns (Invocation memory) { return invocations[id]; }
    function invocationId(Terms calldata t) public view returns (bytes32) {
        return keccak256(abi.encode(CHAIN_ID, address(this), t));
    }
    /// @dev Only the wallet root may call this. Never grant this selector to an agent session.
    function configureSpending(bool enabled, uint64 expiresAt, uint256 perTransaction, uint256 perDay) external onMainnet {
        if (enabled && (expiresAt <= block.timestamp || perTransaction == 0 || perDay == 0 || perTransaction > perDay || perTransaction > maxPayment)) revert InvalidConfiguration();
        spendingPolicies[msg.sender] = SpendingPolicy(enabled, expiresAt, perTransaction, perDay);
        emit SpendingPolicyUpdated(msg.sender, enabled, expiresAt, perTransaction, perDay);
    }
    /// @notice Human/root-authorized funding; must NOT be granted to agent sessions.
    function fund(Terms calldata t) external nonReentrant whenNotPaused onMainnet { _fund(t); }
    /// @notice Session funding requires both wallet selector permission and onchain spend limits.
    function fundWithSession(Terms calldata t) external nonReentrant whenNotPaused onMainnet {
        SpendingPolicy memory p = spendingPolicies[msg.sender];
        uint256 day = block.timestamp / 1 days;
        if (!p.enabled || block.timestamp >= p.expiresAt || t.amount > p.perTransaction || dailySpend[msg.sender][day] + t.amount > p.perDay) revert SpendingDenied();
        dailySpend[msg.sender][day] += t.amount;
        _fund(t);
    }
    function _fund(Terms calldata t) private {
        if (msg.sender != t.buyer || t.provider == address(0) || t.providerOwner == address(0) || t.buyer == t.provider || t.buyer == t.providerOwner || t.amount == 0 || t.amount > maxPayment || t.nonce == bytes32(0)) revert InvalidTerms();
        if (t.acceptBy <= block.timestamp || t.completeBy <= t.acceptBy || t.reviewPeriod == 0) revert InvalidTerms();
        bytes32 id = invocationId(t);
        if (invocations[id].state != State.UNFUNDED) revert InvalidState();
        invocations[id] = Invocation(t, State.FUNDED, bytes32(0), 0);
        uint256 beforeBalance = IERC20(USDG).balanceOf(address(this));
        totalObligations += t.amount;
        IERC20(USDG).safeTransferFrom(t.buyer, address(this), t.amount);
        if (IERC20(USDG).balanceOf(address(this)) != beforeBalance + t.amount) revert InexactTransfer();
        emit InvocationFunded(id, t.buyer, t.provider, t.amount);
    }
    function accept(bytes32 id) external whenNotPaused onMainnet {
        Invocation storage i = invocations[id];
        if (i.state != State.FUNDED) revert InvalidState();
        if (msg.sender != i.terms.provider) revert Unauthorized();
        if (block.timestamp > i.terms.acceptBy) revert Deadline();
        i.state = State.ACCEPTED;
        emit InvocationAccepted(id);
    }
    function submitResult(bytes32 id, bytes32 resultHash) external whenNotPaused onMainnet {
        Invocation storage i = invocations[id];
        if (i.state != State.ACCEPTED || resultHash == bytes32(0)) revert InvalidState();
        if (msg.sender != i.terms.provider) revert Unauthorized();
        if (block.timestamp > i.terms.completeBy) revert Deadline();
        i.state = State.SUBMITTED;
        i.resultHash = resultHash;
        i.reviewBy = uint64(block.timestamp) + i.terms.reviewPeriod;
        emit ResultSubmitted(id, resultHash, i.reviewBy);
    }
    function acceptResult(bytes32 id) external nonReentrant whenNotPaused onMainnet {
        Invocation storage i = invocations[id];
        if (msg.sender != i.terms.buyer) revert Unauthorized();
        if (i.state != State.SUBMITTED) revert InvalidState();
        _release(id, i);
    }
    function releaseAfterWindow(bytes32 id) external nonReentrant whenNotPaused onMainnet {
        Invocation storage i = invocations[id];
        if (i.state != State.SUBMITTED) revert InvalidState();
        if (block.timestamp <= i.reviewBy) revert Deadline();
        _release(id, i);
    }
    function refund(bytes32 id) external nonReentrant onMainnet {
        Invocation storage i = invocations[id];
        if (msg.sender != i.terms.buyer) revert Unauthorized();
        if (!((i.state == State.FUNDED && block.timestamp > i.terms.acceptBy) || (i.state == State.ACCEPTED && block.timestamp > i.terms.completeBy))) revert Deadline();
        _refund(id, i);
    }
    function dispute(bytes32 id) external onMainnet {
        Invocation storage i = invocations[id];
        if (msg.sender != i.terms.buyer) revert Unauthorized();
        if (i.state != State.SUBMITTED) revert InvalidState();
        if (block.timestamp > i.reviewBy) revert Deadline();
        i.state = State.DISPUTED;
        emit DisputeOpened(id);
    }
    function resolveDispute(bytes32 id, bool releaseFunds) external nonReentrant onMainnet onlyRole(RESOLVER_ROLE) {
        Invocation storage i = invocations[id];
        if (i.state != State.DISPUTED) revert InvalidState();
        emit DisputeResolved(id, releaseFunds);
        if (releaseFunds) _release(id, i); else _refund(id, i);
    }
    function _release(bytes32 id, Invocation storage i) private {
        i.state = State.RELEASED;
        totalObligations -= i.terms.amount;
        IERC20(USDG).safeTransfer(i.terms.provider, i.terms.amount);
        emit InvocationReleased(id, i.terms.provider, i.terms.amount);
    }
    function _refund(bytes32 id, Invocation storage i) private {
        i.state = State.REFUNDED;
        totalObligations -= i.terms.amount;
        IERC20(USDG).safeTransfer(i.terms.buyer, i.terms.amount);
        emit InvocationRefunded(id, i.terms.buyer, i.terms.amount);
    }
    // Direct donations cannot be prevented for ERC-20s. They are not obligations
    // or revenue. No admin sweep exists: unsolicited surplus remains quarantined.
}
