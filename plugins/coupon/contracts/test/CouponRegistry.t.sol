// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CouponRegistry} from "../src/CouponRegistry.sol";

contract CouponRegistryTest is Test {
    CouponRegistry reg;
    address stranger = makeAddr("stranger");
    address mac = makeAddr("mac");
    address cvm = makeAddr("cvm");
    bytes32 cdhash = keccak256("cdhash");
    bytes32 compose = keccak256("compose");
    bytes32[] none;

    function setUp() public {
        reg = new CouponRegistry();
        reg.allow(cdhash, 2);
        reg.allow(compose, 2);
        reg.register(mac, cdhash);
    }

    function ids(bytes32 a) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](1);
        r[0] = a;
    }

    function test_ownerOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert(CouponRegistry.NotOwner.selector);
        reg.allow(keccak256("x"), 1);
        vm.expectRevert(CouponRegistry.NotOwner.selector);
        reg.unregister(mac);
        vm.expectRevert(CouponRegistry.NotOwner.selector);
        reg.revoke(cdhash);
        vm.stopPrank();
    }

    function test_register_byPeer_notStranger() public {
        vm.prank(mac);
        reg.register(cvm, compose);
        assertTrue(reg.isPeer(cvm));
        vm.prank(stranger);
        vm.expectRevert(CouponRegistry.NotPeer.selector);
        reg.register(stranger, compose);
    }

    function test_register_disallowedMeasurement_reverts() public {
        vm.expectRevert(CouponRegistry.NotAllowed.selector);
        reg.register(cvm, keccak256("unknown"));
    }

    function test_singlePeer_checkpoints() public {
        vm.prank(mac);
        reg.checkpoint(1, "s1", none);
        assertEq(reg.n(mac), 1);
        assertEq(reg.stateRoot(mac), keccak256("s1"));
    }

    function test_n_mustBeExactlyNext() public {
        vm.startPrank(mac);
        vm.expectRevert(CouponRegistry.BadN.selector);
        reg.checkpoint(2, "gap", none);
        reg.checkpoint(1, "a", none);
        vm.expectRevert(CouponRegistry.BadN.selector);
        reg.checkpoint(1, "replay", none);
        vm.stopPrank();
    }

    function test_staleCopy_cannotCheckpointAfterRestart() public {
        vm.prank(mac);
        reg.checkpoint(1, "before", none);
        vm.prank(mac); // restarted copy reads n=1, writes off reserves, posts 2
        reg.checkpoint(2, "restart", none);
        vm.prank(mac); // the old copy still thinks the next is 2
        vm.expectRevert(CouponRegistry.BadN.selector);
        reg.checkpoint(2, "old copy", none);
    }

    function test_peersCheckpointIndependently() public {
        reg.register(cvm, compose);
        vm.prank(mac);
        reg.checkpoint(1, "m", none);
        vm.prank(cvm);
        reg.checkpoint(1, "c", none);
        assertEq(reg.stateRoot(mac), keccak256("m"));
        assertEq(reg.stateRoot(cvm), keccak256("c"));
    }

    function test_claim_isSingleUseAcrossPeers() public {
        reg.register(cvm, compose);
        bytes32 code = keccak256("code");
        vm.prank(mac);
        reg.checkpoint(1, "m", ids(code));
        assertEq(reg.claimedBy(code), mac);
        vm.prank(cvm);
        vm.expectRevert(CouponRegistry.Claimed_.selector);
        reg.checkpoint(1, "c", ids(code));
        assertEq(reg.n(cvm), 0);
    }

    function test_claim_duplicateInOneCall_reverts() public {
        bytes32[] memory two = new bytes32[](2);
        two[0] = keccak256("r");
        two[1] = keccak256("r");
        vm.prank(mac);
        vm.expectRevert(CouponRegistry.Claimed_.selector);
        reg.checkpoint(1, "m", two);
    }

    function test_revokedMeasurement_peerStops() public {
        reg.revoke(cdhash);
        assertFalse(reg.isPeer(mac));
        vm.prank(mac);
        vm.expectRevert(CouponRegistry.NotPeer.selector);
        reg.checkpoint(1, "m", none);
        vm.prank(mac);
        vm.expectRevert(CouponRegistry.NotPeer.selector);
        reg.register(cvm, compose);
    }

    function test_register_twice_reverts() public {
        vm.expectRevert(CouponRegistry.AlreadyRegistered.selector);
        reg.register(mac, cdhash);
        vm.prank(mac);
        vm.expectRevert(CouponRegistry.AlreadyRegistered.selector);
        reg.register(mac, compose);
    }

    function test_register_limitPerMeasurement() public {
        reg.register(makeAddr("mac2"), cdhash);
        vm.expectRevert(CouponRegistry.TooMany.selector);
        reg.register(makeAddr("mac3"), cdhash);
        assertEq(reg.peerCount(cdhash), 2);
    }

    function test_unregister_stopsPeer_freesSlot() public {
        reg.register(makeAddr("mac2"), cdhash);
        reg.unregister(mac);
        assertFalse(reg.isPeer(mac));
        vm.prank(mac);
        vm.expectRevert(CouponRegistry.NotPeer.selector);
        reg.checkpoint(1, "m", none);
        reg.register(makeAddr("mac3"), cdhash);
        assertEq(reg.peerCount(cdhash), 2);
        vm.expectRevert(CouponRegistry.NotPeer.selector);
        reg.unregister(mac);
    }
}
