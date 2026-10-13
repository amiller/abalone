// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Registry for the coupon peer network: admitted measurements, registered peers, per-peer
/// checkpoints, and single-use claims. Holds no funds. See gateway/DESIGN.md "The registry contract".
contract CouponRegistry {
    address public immutable owner;
    mapping(bytes32 => bool) public allowed;
    mapping(bytes32 => uint32) public maxPeers;
    mapping(bytes32 => uint32) public peerCount;
    mapping(address => bytes32) public measurementOf;
    mapping(address => uint64) public n;
    mapping(address => bytes32) public stateRoot;
    mapping(bytes32 => address) public claimedBy;

    event Allowed(bytes32 indexed measurement, bool ok);
    event Registered(address indexed peer, bytes32 measurement, address by);
    event Unregistered(address indexed peer);
    event Checkpoint(address indexed peer, uint64 n, bytes32 stateRoot);
    event Claimed(bytes32 indexed id, address indexed peer);

    error NotOwner();
    error NotPeer();
    error NotAllowed();
    error BadN();
    error Claimed_();
    error AlreadyRegistered();
    error TooMany();

    constructor() {
        owner = msg.sender;
    }

    function isPeer(address a) public view returns (bool) {
        return allowed[measurementOf[a]];
    }

    /// `max` caps how many peer addresses can be registered under this measurement.
    function allow(bytes32 measurement, uint32 max) external {
        if (msg.sender != owner) revert NotOwner();
        allowed[measurement] = true;
        maxPeers[measurement] = max;
        emit Allowed(measurement, true);
    }

    function revoke(bytes32 measurement) external {
        if (msg.sender != owner) revert NotOwner();
        delete allowed[measurement];
        emit Allowed(measurement, false);
    }

    /// Called by the owner, or by an existing peer after it has verified the new peer's attestation.
    function register(address peer, bytes32 measurement) external {
        if (msg.sender != owner && !isPeer(msg.sender)) revert NotPeer();
        if (!allowed[measurement]) revert NotAllowed();
        if (measurementOf[peer] != bytes32(0)) revert AlreadyRegistered();
        if (peerCount[measurement] >= maxPeers[measurement]) revert TooMany();
        peerCount[measurement]++;
        measurementOf[peer] = measurement;
        emit Registered(peer, measurement, msg.sender);
    }

    function unregister(address peer) external {
        if (msg.sender != owner) revert NotOwner();
        bytes32 m = measurementOf[peer];
        if (m == bytes32(0)) revert NotPeer();
        peerCount[m]--;
        delete measurementOf[peer];
        emit Unregistered(peer);
    }

    /// `n` must be exactly one more than this peer's last, so a stale or cloned copy of a peer cannot
    /// checkpoint. `snapshot` is the peer's state encrypted to its own key; recovery reads it from calldata.
    /// `claims` are single-use ids (redeem codes, releases), claimed atomically.
    function checkpoint(uint64 _n, bytes calldata snapshot, bytes32[] calldata claims) external {
        if (!isPeer(msg.sender)) revert NotPeer();
        if (_n != n[msg.sender] + 1) revert BadN();
        for (uint256 i; i < claims.length; i++) {
            if (claimedBy[claims[i]] != address(0)) revert Claimed_();
            claimedBy[claims[i]] = msg.sender;
            emit Claimed(claims[i], msg.sender);
        }
        n[msg.sender] = _n;
        bytes32 root = keccak256(snapshot);
        stateRoot[msg.sender] = root;
        emit Checkpoint(msg.sender, _n, root);
    }
}
