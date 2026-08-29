// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
// Isolated EVM fixture only. Never compiled into a production deployment.
contract TestUSDG is ERC20 {
    address public attackTarget;
    bytes public attackData;
    bool public attackBlocked;
    constructor() ERC20("Test-only USDG", "USDG") {}
    function symbol() public pure override returns(string memory) { return "USDG"; }
    function decimals() public pure override returns(uint8) { return 6; }
    function mint(address to,uint256 amount) external { _mint(to,amount); }
    function attack(address target,bytes calldata data) external {attackTarget=target;attackData=data;}
    function transferFrom(address from,address to,uint256 amount) public override returns(bool) {
        if(attackTarget!=address(0)) { (bool ok,)=attackTarget.call(attackData); attackBlocked=!ok; }
        return super.transferFrom(from,to,amount);
    }
}
