// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ENSIP-10 / EIP-3668 offchain resolver for *.x402card.eth, after the ENS
// reference implementation (ensdomains/offchain-resolver, MIT). Differences:
// the owner can rotate the gateway URL and signers without redeploying, and
// ECDSA recovery is inlined to avoid a dependency.

interface IExtendedResolver {
    function resolve(bytes memory name, bytes memory data) external view returns (bytes memory);
}

interface IERC165 {
    function supportsInterface(bytes4 interfaceID) external view returns (bool);
}

library SignatureVerifier {
    error InvalidSignatureLength();
    error InvalidSignatureS();

    /// keccak256(0x1900 ‖ target ‖ expires ‖ keccak256(request) ‖ keccak256(result))
    function makeSignatureHash(address target, uint64 expires, bytes memory request, bytes memory result)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(hex"1900", target, expires, keccak256(request), keccak256(result)));
    }

    /// @return signer the recovered signer, and result the verified payload.
    function verify(bytes memory request, bytes calldata response)
        internal
        view
        returns (address signer, bytes memory result)
    {
        (bytes memory res, uint64 expires, bytes memory sig) = abi.decode(response, (bytes, uint64, bytes));
        require(expires >= block.timestamp, "SignatureVerifier: Signature expired");
        signer = recover(makeSignatureHash(address(this), expires, request, res), sig);
        result = res;
    }

    function recover(bytes32 hash, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) revert InvalidSignatureLength();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        // Reject malleable signatures (EIP-2).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert InvalidSignatureS();
        if (v < 27) v += 27;
        address signer = ecrecover(hash, v, r, s);
        require(signer != address(0), "SignatureVerifier: invalid signature");
        return signer;
    }
}

contract OffchainResolver is IExtendedResolver, IERC165 {
    error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData);
    error NotOwner();

    event UrlChanged(string url);
    event SignerChanged(address indexed signer, bool allowed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;
    string public url;
    mapping(address => bool) public signers;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(string memory _url, address[] memory _signers) {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        url = _url;
        emit UrlChanged(_url);
        for (uint256 i = 0; i < _signers.length; i++) {
            signers[_signers[i]] = true;
            emit SignerChanged(_signers[i], true);
        }
    }

    function setUrl(string calldata _url) external onlyOwner {
        url = _url;
        emit UrlChanged(_url);
    }

    function setSigner(address signer, bool allowed) external onlyOwner {
        signers[signer] = allowed;
        emit SignerChanged(signer, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function makeSignatureHash(address target, uint64 expires, bytes memory request, bytes memory result)
        external
        pure
        returns (bytes32)
    {
        return SignatureVerifier.makeSignatureHash(target, expires, request, result);
    }

    /// Always reverts with OffchainLookup; clients fetch from the gateway.
    function resolve(bytes calldata name, bytes calldata data) external view override returns (bytes memory) {
        bytes memory callData = abi.encodeWithSelector(IExtendedResolver.resolve.selector, name, data);
        string[] memory urls = new string[](1);
        urls[0] = url;
        revert OffchainLookup(address(this), urls, callData, OffchainResolver.resolveWithProof.selector, abi.encode(callData, address(this)));
    }

    /// Callback: verifies the gateway signature and returns the inner result.
    function resolveWithProof(bytes calldata response, bytes calldata extraData) external view returns (bytes memory) {
        (bytes memory callData,) = abi.decode(extraData, (bytes, address));
        (address signer, bytes memory result) = SignatureVerifier.verify(callData, response);
        require(signers[signer], "SignatureVerifier: Invalid signature");
        return result;
    }

    function supportsInterface(bytes4 interfaceID) public pure override returns (bool) {
        return interfaceID == type(IExtendedResolver).interfaceId || interfaceID == type(IERC165).interfaceId;
    }
}
